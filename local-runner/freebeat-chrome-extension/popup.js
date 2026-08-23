const statusBox = document.querySelector('#status');
const statusTitle = document.querySelector('#status-title');
const statusDetail = document.querySelector('#status-detail');
const form = document.querySelector('#setup-form');
const apiUrlInput = document.querySelector('#api-url');
const codeInput = document.querySelector('#enrollment-code');
const connectButton = document.querySelector('#connect-button');
const message = document.querySelector('#message');

function showMessage(text, success = false) {
  message.textContent = text;
  message.className = success ? 'message success' : 'message';
}

function showStatus(status) {
  if (!status.connected) {
    statusBox.dataset.state = 'warning';
    statusTitle.textContent = 'Bridge belum tersambung';
    statusDetail.textContent = 'Masukkan URL bot dan kode dari /bridgecode.';
    return;
  }
  if (!status.tabReady) {
    statusBox.dataset.state = 'warning';
    statusTitle.textContent = 'Buka tab Freebeat';
    statusDetail.textContent = 'Login Freebeat di Chrome biasa, lalu refresh halaman generator.';
    return;
  }
  if (!status.sessionReady) {
    statusBox.dataset.state = 'warning';
    statusTitle.textContent = 'Menunggu sesi Freebeat';
    statusDetail.textContent = 'Setelah login, refresh halaman Freebeat sekali.';
    return;
  }
  statusBox.dataset.state = 'ready';
  statusTitle.textContent = status.activeJob ? 'Sedang memproses order' : 'Bridge siap menerima order';
  statusDetail.textContent = status.activeJob
    ? `Order ${status.activeJob.slice(0, 8)} sedang diproses.`
    : 'Tab Freebeat terhubung dan login terdeteksi.';
}

async function refreshStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  showStatus(status);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  connectButton.disabled = true;
  showMessage('Menyambungkan Bridge…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'save-setup',
      apiUrl: apiUrlInput.value,
      code: codeInput.value
    });
    if (!result?.ok) throw new Error(result?.error || 'Gagal menyambungkan Bridge.');
    codeInput.value = '';
    showMessage('Bridge tersambung. Login Freebeat di tab Chrome.', true);
    await refreshStatus();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error));
  } finally {
    connectButton.disabled = false;
  }
});

document.querySelector('#open-freebeat').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'open-freebeat' });
  showMessage('Tab Freebeat dibuka. Login seperti biasa, lalu refresh sekali.', true);
});

refreshStatus();
setInterval(refreshStatus, 2_000);