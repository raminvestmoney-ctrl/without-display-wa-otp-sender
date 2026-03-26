const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
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

// ══════════════════════════════════════════
//  INITIALIZE WHATSAPP CONNECTION
// ══════════════════════════════════════════
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'warn' }), // 🔹 Changed from silent to warn to see errors
        browser: ['Railway SMS Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
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
//  START SERVER
// ══════════════════════════════════════════
app.listen(PORT, () => {
    console.log('═'.repeat(50));
    console.log(`🚀 WhatsApp Bot running on port ${PORT}`);
    console.log('═'.repeat(50));
    connectToWhatsApp();
});
