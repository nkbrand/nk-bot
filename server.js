const express = require('express');
const path = require('path');
const fs = require('fs');
const Pino = require('pino');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { downloadMedia } = require('./downloaders');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const sessions = {};

// ================== BOT HANDLER ==================
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

// ================== PAIRING API ==================
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    if (sessions[phoneNumber]) {
        return res.json({ success: true, code: 'ALREADY_CONNECTED', message: 'Bot already connected for this number.' });
    }

    try {
        const sessionPath = `./sessions/${phoneNumber}`;
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            auth: state,
            logger: Pino({ level: 'silent' }),
            browser: ['Chrome (Linux)', 'Chrome', '120.0.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        // Try pairing code
        let code = await sock.requestPairingCode(phoneNumber);
        const formattedCode = code.match(/.{1,3}/g).join('-');

        sessions[phoneNumber] = sock;
        setupBot(sock, phoneNumber);

        return res.json({ success: true, code: formattedCode });

    } catch (err) {
        console.error('Pairing Error:', err);

        // Fallback: Generate QR code image
        try {
            const fallbackSock = makeWASocket({
                auth: state,
                logger: Pino({ level: 'silent' }),
                browser: ['Chrome (Linux)', 'Chrome', '120.0.0.0']
            });

            const qrPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('QR timeout')), 30000);
                fallbackSock.ev.on('connection.update', async (update) => {
                    if (update.qr) {
                        clearTimeout(timeout);
                        const qrImage = await QRCode.toDataURL(update.qr);
                        resolve({ qrImage });
                    }
                });
            });

            const result = await qrPromise;
            return res.json({
                success: false,
                error: 'Pairing failed. Use QR code.',
                fallback: true,
                qrImage: result.qrImage,
                instruction: 'Scan with WhatsApp → Linked Devices → Link with device'
            });

        } catch (fallbackErr) {
            console.error('QR fallback failed:', fallbackErr);
            return res.status(500).json({ success: false, error: 'Both pairing and QR failed.' });
        }
    }
});

// ================== SERVE WEBSITE ==================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 NK Professional Bot Server running on port ${PORT}`);
});
