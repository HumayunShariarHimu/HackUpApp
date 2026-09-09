const sendBtn = document.getElementById('sendAllBtn');
const statusMsg = document.getElementById('statusMsg');

sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  statusMsg.textContent = '';
  try {
    const res = await fetch('/api/send-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      statusMsg.style.color = 'var(--neon-green)';
      statusMsg.textContent = '✅ All data sent successfully to Telegram!';
    } else {
      throw new Error(data.error || 'Failed to send');
    }
  } catch (err) {
    statusMsg.style.color = 'var(--neon-pink)';
    statusMsg.textContent = '❌ Error: ' + err.message;
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send All Data to Telegram';
  }
});
