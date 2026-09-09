const API_BASE = '/api';

// DOM refs
const taskList = document.getElementById('taskList');
const taskInput = document.getElementById('taskInput');
const addBtn = document.getElementById('addTaskBtn');
const refreshBtn = document.getElementById('refreshBtn');
const testTelegramBtn = document.getElementById('testTelegramBtn');

const totalTasksEl = document.getElementById('totalTasks');
const completedTasksEl = document.getElementById('completedTasks');
const pendingTasksEl = document.getElementById('pendingTasks');
const activityCountEl = document.getElementById('activityCount');
const taskCountEl = document.getElementById('taskCount');
const activityLogEl = document.getElementById('activityLog');

let chart = null;

// Fetch and render all data
async function loadAll() {
  try {
    const [tasksRes, activityRes] = await Promise.all([
      fetch(`${API_BASE}/tasks`),
      fetch(`${API_BASE}/activity`)
    ]);
    const tasks = await tasksRes.json();
    const activity = await activityRes.json();
    renderTasks(tasks);
    renderStats(tasks);
    renderActivity(activity);
    updateChart(tasks);
  } catch (err) {
    console.error('Load error:', err);
  }
}

// Render tasks
function renderTasks(tasks) {
  taskList.innerHTML = '';
  tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item';
    const titleSpan = document.createElement('span');
    titleSpan.className = `task-title ${task.completed ? 'completed' : ''}`;
    titleSpan.textContent = task.title;
    // Toggle completion on click
    titleSpan.addEventListener('click', () => toggleTask(task.id, !task.completed));

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTask(task.id);
    });
    actions.appendChild(deleteBtn);

    li.appendChild(titleSpan);
    li.appendChild(actions);
    taskList.appendChild(li);
  });
  taskCountEl.textContent = `${tasks.length} tasks`;
}

// Render stats
function renderStats(tasks) {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pending = total - completed;
  totalTasksEl.textContent = total;
  completedTasksEl.textContent = completed;
  pendingTasksEl.textContent = pending;
}

// Render activity log
function renderActivity(activity) {
  activityLogEl.innerHTML = '';
  activity.slice(0, 10).forEach(entry => {
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.innerHTML = `
      <span>${entry.action}</span>
      <span class="time">${new Date(entry.timestamp).toLocaleString()}</span>
    `;
    activityLogEl.appendChild(div);
  });
  activityCountEl.textContent = activity.length;
}

// Update Chart.js pie chart
function updateChart(tasks) {
  const completed = tasks.filter(t => t.completed).length;
  const pending = tasks.length - completed;
  const ctx = document.getElementById('statusChart').getContext('2d');
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: ['Completed', 'Pending'],
      datasets: [{
        data: [completed, pending],
        backgroundColor: ['#00f5a0', '#ffd700'],
        borderColor: '#12121f',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          labels: { color: '#e0e0ff' }
        }
      }
    }
  });
}

// CRUD operations
async function addTask() {
  const title = taskInput.value.trim();
  if (!title) return;
  try {
    const res = await fetch(`${API_BASE}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (res.ok) {
      taskInput.value = '';
      loadAll();
    }
  } catch (err) { console.error(err); }
}

async function toggleTask(id, completed) {
  try {
    await fetch(`${API_BASE}/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed })
    });
    loadAll();
  } catch (err) { console.error(err); }
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await fetch(`${API_BASE}/tasks/${id}`, { method: 'DELETE' });
    loadAll();
  } catch (err) { console.error(err); }
}

// Test Telegram
async function testTelegram() {
  try {
    const res = await fetch(`${API_BASE}/telegram/test`, { method: 'POST' });
    const data = await res.json();
    alert(data.success ? '✅ Test message sent!' : '❌ Failed: ' + data.error);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Event listeners
addBtn.addEventListener('click', addTask);
taskInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addTask(); });
refreshBtn.addEventListener('click', loadAll);
testTelegramBtn.addEventListener('click', testTelegram);

// Load on page load
loadAll();
