const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const crypto = require('crypto');

// ══════════════════════════════════════════
//  CRASH PROTECTION — must be first
// ══════════════════════════════════════════
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled rejection (caught):', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught exception (caught):', err?.message || err);
});

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
const AUTH_FOLDER = 'auth_info_baileys';

// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════
let sock = null;
let groupJid = null;
let currentQr = null;
let isReady = false;
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

// ══════════════════════════════════════════
//  WAIT UNTIL READY
// ══════════════════════════════════════════
function waitUntilReady(timeoutMs = 20000) {
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
//  SCHEDULE RECONNECT (with backoff)
// ══════════════════════════════════════════
function scheduleReconnect(delayMs) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToWhatsApp();
    }, delayMs);
}

// ══════════════════════════════════════════
//  CONNECT TO WHATSAPP
// ══════════════════════════════════════════
async function connectToWhatsApp() {
    if (isConnecting) {
        console.log('⏳ Already connecting, skipping...');
        return;
    }

    isConnecting = true;
    isReady = false;
    groupJid = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`🔌 Connecting with Baileys v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                // ✅ makeCacheableSignalKeyStore fixes "No sessions" error
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            logger: pino({ level: 'silent' }),
            browser: ['SMS-Bot', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 2000,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                currentQr = qr;
                isReady = false;
                console.log('📱 New QR — scan at /qr');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isReady = false;
                isConnecting = false;

                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode || error?.status;
                const reason = error?.message || 'Unknown';

                console.log(`❌ Disconnected. Code: ${statusCode} | Reason: ${reason}`);

                // 401 = logged out, needs fresh QR
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    console.log('🚫 Logged out! Delete auth_info_baileys and re-scan QR.');
                    currentQr = null;
                    return;
                }

                // 440 = conflict (another WA session open on PC/phone)
                if (statusCode === 440) {
                    reconnectAttempts++;
                    const delay = Math.min(15000 * reconnectAttempts, 60000);
                    console.log(`⚠️ Conflict! Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
                    console.log('💡 Close WhatsApp Web on PC to stop conflicts!');
                    scheduleReconnect(delay);
                    return;
                }

                // All other disconnects
                reconnectAttempts++;
                const delay = Math.min(5000 * reconnectAttempts, 30000);
                console.log(`🔄 Reconnecting in ${delay / 1000}s...`);
                scheduleReconnect(delay);

            } else if (connection === 'open') {
                reconnectAttempts = 0;
                currentQr = null; // Clear QR — no longer needed
                console.log('✅ WhatsApp connected!');

                // ✅ Wait for Baileys internal key sync — prevents "No sessions"
                console.log('⏳ Syncing session keys (5s)...');
                await new Promise(r => setTimeout(r, 5000));

                await findGroupJid();

                isReady = true;
                isConnecting = false;
                console.log('🟢 Bot is fully ready to send messages!');
            }
        });

        sock.ev.on('messages.upsert', () => {});

    } catch (err) {
        console.error('❌ connectToWhatsApp error:', err.message);
        isConnecting = false;
        scheduleReconnect(10000);
    }
}

// ══════════════════════════════════════════
//  FIND GROUP JID
// ══════════════════════════════════════════
async function findGroupJid() {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups);

        console.log('\n📋 Available Groups:');
        groupList.forEach((g, i) => console.log(`  ${i + 1}. ${g.subject}`));

        const target = groupList.find(g => g.subject === GROUP_NAME);
        if (target) {
            groupJid = target.id;
            console.log(`✅ Group found: "${GROUP_NAME}" → ${groupJid}\n`);
        } else {
            console.log(`⚠️ Group "${GROUP_NAME}" NOT found. Check GROUP_NAME env var.\n`);
        }
    } catch (err) {
        console.error('❌ Error fetching groups:', err.message);
    }
}

// ══════════════════════════════════════════
//  SEND MESSAGE (3 attempts with backoff)
// ══════════════════════════════════════════
async function sendToGroup(message) {
    if (!sock) {
        console.log('❌ sock is null');
        return false;
    }

    try {
        await waitUntilReady(20000);
    } catch (e) {
        console.log('❌ Not ready in time:', e.message);
        return false;
    }

    if (!groupJid) {
        console.log('⚠️ No groupJid, retrying fetch...');
        await findGroupJid();
        if (!groupJid) return false;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await sock.sendMessage(groupJid, { text: message });
            console.log(`✅ Sent (attempt ${attempt}): ${message}`);
            return true;
        } catch (err) {
            console.error(`❌ Send attempt ${attempt} failed: ${err.message}`);

            if (attempt < 3) {
                const wait = attempt * 3000;
                console.log(`🔄 Retrying in ${wait / 1000}s...`);
                await new Promise(r => setTimeout(r, wait));

                if (err.message?.includes('No sessions') || err.message?.includes('Timed Out')) {
                    console.log('🔑 Key sync issue — waiting extra 5s...');
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }
    }

    console.log('🔄 All send attempts failed. Triggering reconnect...');
    isReady = false;
    isConnecting = false;
    scheduleReconnect(3000);
    return false;
}

// ══════════════════════════════════════════
//  API ENDPOINTS
// ══════════════════════════════════════════
app.post('/send_code', async (req, res) => {
    const { code, message } = req.body;
    if (!code) return res.status(400).json({ status: 'no_code' });

    console.log(`📩 Send request — code: ${code}`);
    const result = await sendToGroup(message || code);

    res.json({
        status: result ? 'sent' : 'failed',
        code,
        group: GROUP_NAME,
        connected: !!sock,
        ready: isReady,
    });
});

app.get('/qr', async (req, res) => {
    if (!currentQr) {
        return res.send(`
            <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5;font-family:sans-serif;">
                <div style="background:white;padding:40px;border-radius:20px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.1);">
                    <h2>✅ Already Connected</h2>
                    <p>Bot is running — no QR needed.</p>
                    <p style="color:#888;font-size:13px;">To re-link: delete <b>auth_info_baileys</b> folder and redeploy.</p>
                    <button onclick="window.location.reload()" style="margin-top:16px;padding:10px 20px;background:#25d366;color:white;border:none;border-radius:10px;cursor:pointer;font-weight:bold;">Refresh</button>
                </div>
            </body>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQr);
        res.send(`
            <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5;font-family:sans-serif;">
                <div style="background:white;padding:40px;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1);text-align:center;">
                    <h1 style="color:#1d1d1f;margin-bottom:8px;">📱 Link WhatsApp</h1>
                    <p style="color:#888;margin-bottom:20px;">Open WhatsApp → Linked Devices → Link a Device</p>
                    <img src="${qrImage}" style="width:280px;height:280px;border:8px solid #f0f2f5;border-radius:12px;" />
                    <p style="color:#86868b;margin-top:16px;font-size:13px;">QR expires every ~20 seconds</p>
                    <button onclick="window.location.reload()" style="margin-top:12px;padding:10px 24px;border:none;background:#25d366;color:white;border-radius:10px;cursor:pointer;font-weight:bold;font-size:15px;">🔄 Refresh QR</button>
                </div>
            </body>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR');
    }
});

app.get('/test', (req, res) => {
    res.json({
        status: 'running',
        whatsapp_connected: !!sock,
        group_found: !!groupJid,
        group_name: GROUP_NAME,
        ready: isReady,
        reconnect_attempts: reconnectAttempts,
    });
});

app.get('/groups', async (req, res) => {
    if (!sock) return res.status(503).json({ error: 'Not connected' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({
            name: g.subject,
            id: g.id,
            participants: g.participants.length,
        }));
        res.json({ groups: list, total: list.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════
//  START
// ══════════════════════════════════════════
app.listen(PORT, () => {
    console.log('═'.repeat(50));
    console.log(`🚀 WhatsApp Bot on port ${PORT}`);
    console.log(`📁 Session folder: ${AUTH_FOLDER}/`);
    console.log(`👥 Target group: ${GROUP_NAME}`);
    console.log('═'.repeat(50));
    connectToWhatsApp();
});
