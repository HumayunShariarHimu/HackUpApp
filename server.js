require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In‑memory data ----------
let tasks = [
  { id: 1, title: 'Design dashboard', completed: true },
  { id: 2, title: 'Integrate Telegram bot', completed: false },
  { id: 3, title: 'Deploy to Vercel', completed: false }
];
let nextId = 4;
let activityLog = [
  { action: 'System initialized', timestamp: new Date().toISOString() }
];

// ---------- Telegram sender ----------
async function sendTelegramMessage(text) {
  const token = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  if (!token || !chatId) {
    console.warn('Telegram credentials missing – message not sent');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Telegram send error:', error.message);
  }
}

// Add activity log entry and optionally notify
async function addActivity(action, notify = false) {
  const entry = { action, timestamp: new Date().toISOString() };
  activityLog.unshift(entry);
  if (activityLog.length > 50) activityLog.pop();
  if (notify) {
    await sendTelegramMessage(`📌 <b>HackUp</b>\n${action}`);
  }
  return entry;
}

// ---------- API routes ----------

// Get all tasks
app.get('/api/tasks', (req, res) => {
  res.json(tasks);
});

// Get activity log
app.get('/api/activity', (req, res) => {
  res.json(activityLog);
});

// Create a new task
app.post('/api/tasks', async (req, res) => {
  const { title } = req.body;
  if (!title || title.trim() === '') {
    return res.status(400).json({ error: 'Task title required' });
  }
  const newTask = {
    id: nextId++,
    title: title.trim(),
    completed: false
  };
  tasks.push(newTask);
  const msg = `✅ Task added: "${newTask.title}" (ID: ${newTask.id})`;
  await addActivity(msg, true);
  res.status(201).json(newTask);
});

// Update task (toggle or edit)
app.put('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const task = tasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { title, completed } = req.body;
  if (title !== undefined) task.title = title.trim();
  if (completed !== undefined) task.completed = completed;
  const msg = `🔄 Task updated: "${task.title}" | completed: ${task.completed}`;
  await addActivity(msg, true);
  res.json(task);
});

// Delete a task
app.delete('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return res.status(404).json({ error: 'Task not found' });
  const removed = tasks.splice(index, 1)[0];
  const msg = `🗑️ Task deleted: "${removed.title}"`;
  await addActivity(msg, true);
  res.json({ message: 'Task deleted', task: removed });
});

// ---------- SPECIAL: Send all data to Telegram ----------
app.post('/api/send-all', async (req, res) => {
  try {
    // Build a detailed report
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const pending = total - completed;
    const taskList = tasks.map(t => 
      `• ${t.title} ${t.completed ? '✅' : '⏳'}`
    ).join('\n');
    const recentActivity = activityLog.slice(0, 5).map(a => 
      `• ${a.action} (${new Date(a.timestamp).toLocaleString()})`
    ).join('\n');

    const message = `
<b>📊 HackUp Report</b>

<b>Tasks:</b> ${total}
• Completed: ${completed}
• Pending: ${pending}

<b>Task List:</b>
${taskList || 'No tasks yet.'}

<b>Recent Activity:</b>
${recentActivity || 'No activity yet.'}

Generated: ${new Date().toLocaleString()}
    `.trim();

    await sendTelegramMessage(message);
    await addActivity('📤 Sent full report to Telegram', false); // log but don't notify again
    res.json({ success: true, message: 'All data sent to Telegram' });
  } catch (error) {
    console.error('Send-all error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test Telegram notification
app.post('/api/telegram/test', async (req, res) => {
  try {
    await sendTelegramMessage('🧪 <b>Test notification</b> from HackUp!');
    res.json({ success: true, message: 'Test sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve static pages
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 HackUp running on port ${PORT}`);
});
