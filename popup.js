const key = document.getElementById('key'), status = document.getElementById('status');
chrome.storage.sync.get('pangramKey').then(({ pangramKey }) => { if (pangramKey) { key.value = pangramKey; status.textContent = 'Key saved ✓'; status.className = 'ok'; } else status.textContent = 'No key yet.'; });
document.getElementById('save').onclick = async () => {
  const v = key.value.trim();
  await chrome.storage.sync.set({ pangramKey: v });
  status.textContent = v ? 'Key saved ✓' : 'Key removed.'; status.className = v ? 'ok' : '';
};
const cp = document.getElementById('chromePopups');
chrome.storage.sync.get('chromePopups').then(({ chromePopups }) => { cp.checked = !!chromePopups; });
cp.onchange = () => chrome.storage.sync.set({ chromePopups: cp.checked });
