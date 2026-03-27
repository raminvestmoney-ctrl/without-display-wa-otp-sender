const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const crypto = require('crypto');

if (!global.crypto) {
    global.crypto = crypto;
}

const app = express();
app.use(express.json());

// ══════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════
const GROUP_NAME = process.env.GROUP_NAME || "ram";
const PORT = 5001;

let sock;
let groupJid = null;
let currentQr = null;
let isReady = false; // 🔑 KEY FIX: Track if socket is truly ready to send

// ══════════════════════════════════════════
//  WAIT UNTIL READY HELPER
// ══════════════════════════════════════════
function waitUntilReady(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        if (isReady) return resolve();
        const start = Date.now();
        const interval = setInterval(() => {
            if (isReady) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(interval);
                reject(new Error('Timed out waiting for WhatsApp to be ready'));
            }
        }, 300);
    });
}

// ══════════════════════════════════════════
//  INITIALIZE WHATSAPP CONNECTION
// ══════════════════════════════════════════
async function connectToWhatsApp() {
    isReady = false; // Reset on each reconnect

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'warn' }),
        browser: ['Railway SMS Bot', 'Chrome', '1.0.0'],
        // 🔑 KEY FIX: Give Baileys more time to sync keys after connect
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQr = qr;
            isReady = false; // Not ready while showing QR
            console.log('📱 Scan this QR code with WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isReady = false;
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode || error?.status;
            const message = error?.message || 'Unknown reason';

            console.log(`❌ Connection closed. Status: ${statusCode}, Reason: ${message}`);

            const shouldReconnect = (error instanceof Boom)
                ? statusCode !== DisconnectReason.loggedOut
                : true;

            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 10 seconds...');
                setTimeout(connectToWhatsApp, 10000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');

            // 🔑 KEY FIX: Wait 4 seconds for Baileys to finish syncing
            // signal store / session keys before we try to use it.
            // "No sessions" happens when we call sendMessage too fast after open.
            console.log('⏳ Waiting for session keys to sync...');
            await new Promise(r => setTimeout(r, 4000));

            await findGroupJid();

            isReady = true; // ✅ Now truly ready
            console.log('🟢 Bot is fully ready to send messages!');
        }
    });

    sock.ev.on('messages.upsert', () => {});
}

// ══════════════════════════════════════════
//  FIND GROUP JID
// ══════════════════════════════════════════
async function findGroupJid() {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);

        console.log('\n📋 Available Groups:');
        groupList.forEach((group, index) => {
            console.log(`${index + 1}. ${group.subject}`);
        });

        const targetGroup = groupList.find(g => g.subject === GROUP_NAME);

        if (targetGroup) {
            groupJid = targetGroup.id;
            console.log(`\n✅ Target group found: ${GROUP_NAME}`);
            console.log(`🆔 Group JID: ${groupJid}\n`);
        } else {
            console.log(`\n⚠️ Group "${GROUP_NAME}" not found!`);
            console.log('💡 Available groups listed above. Update GROUP_NAME in code.\n');
        }
    } catch (error) {
        console.error('❌ Error fetching groups:', error.message);
    }
}

// ══════════════════════════════════════════
//  SEND MESSAGE TO GROUP
// ══════════════════════════════════════════
async function sendToGroup(message) {
    if (!sock) {
        console.log('❌ WhatsApp not connected! (sock is null)');
        return false;
    }

    // 🔑 KEY FIX: Wait for socket to be fully ready before sending
    try {
        await waitUntilReady(15000);
    } catch (e) {
        console.log('❌ Socket not ready in time:', e.message);
        return false;
    }

    if (!groupJid) {
        console.log('⚠️ Group JID not found, retrying...');
        await findGroupJid();
        if (!groupJid) return false;
    }

    try {
        await sock.sendMessage(groupJid, { text: message });
        console.log(`✅ Message sent to group: ${message}`);
        return true;
    } catch (error) {
        console.error('❌ WhatsApp Send Error:', error.message);

        // 🔑 KEY FIX: On "No sessions", wait longer and retry once
        if (error.message.includes('No sessions')) {
            console.log('🔄 "No sessions" detected — waiting 5s for key sync and retrying...');
            await new Promise(r => setTimeout(r, 5000));
            try {
                await sock.sendMessage(groupJid, { text: message });
                console.log('✅ Retry succeeded!');
                return true;
            } catch (retryErr) {
                console.error('❌ Retry failed:', retryErr.message);
                // If still failing, force a full reconnect
                console.log('🔄 Forcing reconnect to fix session...');
                isReady = false;
                setTimeout(connectToWhatsApp, 1000);
            }
        }
        return false;
    }
}

// ══════════════════════════════════════════
//  API ENDPOINTS
// ══════════════════════════════════════════
app.post('/send_code', async (req, res) => {
    const { code, message } = req.body;

    if (!code) {
        return res.status(400).json({ status: 'no_code' });
    }

    console.log(`📩 Request received to send code: ${code}`);
    const result = await sendToGroup(code);

    res.json({
        status: result ? 'sent' : 'failed',
        code: code,
        group: GROUP_NAME,
        connected: !!sock && groupJid != null,
        ready: isReady
    });
});

app.get('/qr', async (req, res) => {
    if (!currentQr) {
        return res.send('<h1>⏰ No QR code available yet.</h1><p>Wait for the bot to generate one in the logs.</p>');
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQr);
        res.send(`
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5;font-family:sans-serif;">
                <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1);text-align:center;">
                    <h1 style="color:#1d1d1f;margin-bottom:20px;">Link WhatsApp</h1>
                    <img src="${qrImage}" style="width:300px;height:300px;border:10px solid #fff;outline:1px solid #eee;" />
                    <p style="color:#86868b;margin-top:20px;font-size:14px;">Scan this with your phone<br><b>Linked Devices > Link a Device</b></p>
                    <button onclick="window.location.reload()" style="margin-top:20px;padding:10px 20px;border:none;background:#25d366;color:white;border-radius:10px;cursor:pointer;font-weight:bold;">Refresh Code</button>
                </div>
            </body>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code');
    }
});

app.get('/test', (req, res) => {
    res.json({
        status: 'running',
        whatsapp_connected: !!sock,
        group_found: !!groupJid,
        group_name: GROUP_NAME,
        ready: isReady  // 🔑 Now visible in /test response
    });
});

app.get('/groups', async (req, res) => {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({
            name: g.subject,
            id: g.id,
            participants: g.participants.length
        }));
        res.json({ groups: groupList });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ══════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════
app.listen(PORT, () => {
    console.log('═'.repeat(50));
    console.log(`🚀 WhatsApp Bot running on port ${PORT}`);
    console.log('═'.repeat(50));
    connectToWhatsApp();
});
