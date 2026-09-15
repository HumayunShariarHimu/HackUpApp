require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const IS_VERCEL = !!process.env.VERCEL;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory state (dashboard only) ----------
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

// ---------- Telegram direct helper (dashboard/legacy endpoints) ----------
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

// ---------- API ----------

// Browser fetches this to get credentials (from Vercel env vars, NOT from Git)
app.get('/api/config', (req, res) => {
  if (!tgReady()) return res.status(500).json({ error: 'Telegram env vars not set' });
  res.set('Cache-Control', 'no-store');
  res.json({ token: BOT_TOKEN, chatId: CHAT_ID });
});

app.get('/api/health', (_, res) => res.json({
  ok: true,
  telegramConfigured: tgReady(),
  uptime: process.uptime()
}));

app.post('/api/telegram/test', async (_, res) => {
  try { await tgSend('✅ HackUp test message'); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-all', async (_, res) => {
  try { const r = await tgSend('📤 HackUp send-all test'); res.json({ success: r.ok === true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/telegram/message', async (req, res) => {
  try {
    const r = await tgSend(req.body.text || '');
    res.json({ success: r.ok === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// Fallback static
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message || 'Server error' });
});

if (require.main === module && !IS_VERCEL) {
  app.listen(PORT, () => console.log(`🚀 HackUp → http://localhost:${PORT}`));
}
module.exports = app;
