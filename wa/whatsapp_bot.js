const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // 🔹 For browser image
const crypto = require('crypto');

// 🔹 Fix for "crypto is not defined" error in some environments
if (!global.crypto) {
    global.crypto = crypto;
}

const app = express();
app.use(express.json());

// ══════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════
const GROUP_NAME = process.env.GROUP_NAME || "ram"; // 🔹 Change this!
const PORT = 5001; // Internal port for WhatsApp bot

let sock;
let groupJid = null;
let currentQr = null; // 🔹 Store latest QR
let saveCreds = null; // 🔹 Hoisted so shutdown handlers can flush credentials

// ══════════════════════════════════════════
//  INITIALIZE WHATSAPP CONNECTION
// ══════════════════════════════════════════
async function connectToWhatsApp() {
    const { state, saveCreds: _saveCreds } = await useMultiFileAuthState('/app/.wwebjs_cache');
    saveCreds = _saveCreds; // 🔹 Expose to module scope for shutdown handlers
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'warn' }), // 🔹 Changed from silent to warn to see errors
        browser: ['Railway SMS Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', () => saveCreds && saveCreds());

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQr = qr; // 🔹 Store it
            console.log('📱 Scan this QR code with WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
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
            await findGroupJid();
        }
    });

    sock.ev.on('messages.upsert', () => {});
}

// ══════════════════════════════════════════
//  FIND GROUP JID (Internal WhatsApp ID)
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
        console.log('❌ WhatsApp not connected!');
        return false;
    }

    if (!groupJid) {
        console.log('❌ Group JID not found! Check GROUP_NAME.');
        return false;
    }

    try {
        await sock.sendMessage(groupJid, { text: message });
        console.log(`✅ Message sent: ${message}`);
        return true;
    } catch (error) {
        console.error('❌ Send failed:', error.message);
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

    console.log(`📩 Received code: ${code}`);
    const result = await sendToGroup(code);

    res.json({
        status: result ? 'sent' : 'failed',
        code: code,
        group: GROUP_NAME
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
        group_name: GROUP_NAME
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
//  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════
async function shutdown(signal) {
    console.log(`\n⚠️  Received ${signal}. Saving session and shutting down...`);
    try {
        if (saveCreds) {
            await saveCreds();
            console.log('💾 Credentials saved successfully.');
        }
        if (sock) {
            sock.end();
            console.log('🔌 WhatsApp socket closed.');
        }
    } catch (err) {
        console.error('❌ Error during shutdown:', err.message);
    }
    // Give the filesystem a moment to flush writes before the process exits
    setTimeout(() => {
        console.log('👋 Exiting cleanly.');
        process.exit(0);
    }, 2500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ══════════════════════════════════════════
//  UNHANDLED ERROR HANDLERS
// ══════════════════════════════════════════
process.on('uncaughtException', async (err) => {
    console.error('💥 Uncaught exception:', err);
    try {
        if (saveCreds) await saveCreds();
        console.log('💾 Credentials saved after uncaught exception.');
    } catch (saveErr) {
        console.error('❌ Failed to save credentials:', saveErr.message);
    }
    setTimeout(() => process.exit(1), 2500);
});

process.on('unhandledRejection', async (reason) => {
    console.error('💥 Unhandled promise rejection:', reason);
    try {
        if (saveCreds) await saveCreds();
        console.log('💾 Credentials saved after unhandled rejection.');
    } catch (saveErr) {
        console.error('❌ Failed to save credentials:', saveErr.message);
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

    // 🔹 Periodic heartbeat so Railway logs confirm the process is alive
    setInterval(() => {
        console.log(`💓 Heartbeat — connected: ${!!sock}, group: ${groupJid || 'not found'}`);
    }, 5 * 60 * 1000); // every 5 minutes
});
