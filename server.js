const express = require('express');
const path = require('path');
const fs = require('fs');
const Pino = require('pino');
const axios = require('axios');
const QRCode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { downloadMedia } = require('./downloaders');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Active Sessions Store
const sessions = {};

// ================== BOT MESSAGE HANDLER ==================
function setupBot(sock, phoneNumber) {
    const BOT_NAME = "NK PROFESSIONAL";
    const CREATOR = "NK";
    const PHONE = "923083016818";
    let startTime = Date.now();

    const VIDEO_CAPTION = `
╭━━━━━━━━━━━━━━━━━━━━━━╮
      ✦ ${BOT_NAME} ✦
   🎬 HD • Fastest Delivery
   🔊 Audio Boosted
   🧑‍💻 ${CREATOR}
   📞 ${PHONE}
╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    const ALIVE_MSG = `
╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮
        ✦ ${BOT_NAME} ✦
     🤖 Fastest Downloader Bot
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

🚀 Status     : Online
👨‍💻 Creator   : ${CREATOR}
⚡ Engine     : Baileys
📥 Supports   : TikTok & Facebook
🔊 Audio      : Boosted (Crystal Clear)
⏳ Uptime     : ${Math.floor((Date.now() - startTime)/1000)}s

╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯
💬 Send TikTok or Facebook link to download!`;

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;
            const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
            if (!text) continue;

            const msgLower = text.toLowerCase().trim();
            const jid = m.key.remoteJid;

            if (msgLower === '.alive') {
                await sock.sendMessage(jid, { text: ALIVE_MSG });
                continue;
            }

            const urls = text.match(/https?:\/\/[^\s]+/g);
            if (!urls) continue;

            for (const url of urls) {
                if (!url.includes('tiktok.com') && !url.includes('facebook.com') && !url.includes('fb.watch')) {
                    await sock.sendMessage(jid, { text: '⚠️ Only TikTok & Facebook links are supported.' });
                    continue;
                }

                const processingMsg = await sock.sendMessage(jid, { text: '⏳ Downloading HD video with boosted audio...' });
                let file = null;
                try { file = await downloadMedia(url); } catch (err) { console.error(err); }

                if (!file) {
                    await sock.sendMessage(jid, { text: '❌ Failed to download.' });
                    await sock.sendMessage(jid, { delete: processingMsg.key });
                    continue;
                }

                try {
                    const stats = fs.statSync(file);
                    if (stats.size > 50 * 1024 * 1024) {
                        await sock.sendMessage(jid, { text: '❌ Video too large (max 50MB).' });
                        if (fs.existsSync(file)) fs.unlinkSync(file);
                        await sock.sendMessage(jid, { delete: processingMsg.key });
                        continue;
                    }
                    await sock.sendMessage(jid, { video: { url: file }, mimetype: 'video/mp4', caption: VIDEO_CAPTION });
                } catch (err) {
                    await sock.sendMessage(jid, { text: '❌ Error sending video.' });
                } finally {
                    if (fs.existsSync(file)) fs.unlinkSync(file);
                    await sock.sendMessage(jid, { delete: processingMsg.key });
                }
            }
        }
    });
}

// ================== PAIRING API (FIXED: Waits for connection) ==================
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    if (sessions[phoneNumber]) {
        return res.json({ success: true, code: 'ALREADY_CONNECTED', message: 'Bot already connected for this number.' });
    }

    try {
        const sessionPath = `./sessions/${phoneNumber}`;
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // ========== CREATE SOCKET ==========
        const sock = makeWASocket({
            auth: state,
            logger: Pino({ level: 'silent' }),
            browser: ['NK Professional', 'Chrome', '1.0'],
            printQRInTerminal: true // Fallback if pairing fails
        });

        sock.ev.on('creds.update', saveCreds);

        // ========== WAIT FOR CONNECTION TO BE READY ==========
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout (30s)')), 30000);
            
            const handler = (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'open') {
                    clearTimeout(timeout);
                    sock.ev.off('connection.update', handler);
                    resolve();
                }
                if (connection === 'close') {
                    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (!shouldReconnect) {
                        clearTimeout(timeout);
                        sock.ev.off('connection.update', handler);
                        reject(new Error('Logged out or closed'));
                    }
                }
            };
            sock.ev.on('connection.update', handler);
        });

        // ========== REQUEST PAIRING CODE (Now socket is ready) ==========
        console.log(`Generating pairing code for ${phoneNumber}...`);
        let code = await sock.requestPairingCode(phoneNumber);
        
        // Format code
        const formattedCode = code.match(/.{1,3}/g).join('-');

        // Store session for later if needed (bot will auto reconnect via creds)
        sessions[phoneNumber] = sock;
        setupBot(sock, phoneNumber);

        return res.json({ success: true, code: formattedCode });

    } catch (err) {
        console.error("Pairing Error:", err);
        // Fallback: Agar pairing fail ho (IP block), toh QR code method batao
        return res.status(500).json({ 
            success: false, 
            error: err.message,
            fallback: "Pairing failed. Try QR code method (will be shown on next try) or use a different network."
        });
    }
});

// ================== SERVE WEBSITE ==================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================== START SERVER ==================
app.listen(PORT, () => {
    console.log(`🚀 NK Professional Bot Server is running on port ${PORT}`);
});
