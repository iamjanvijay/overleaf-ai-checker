const key = document.getElementById('key'), status = document.getElementById('status');
chrome.storage.sync.get('pangramKey').then(({ pangramKey }) => { if (pangramKey) { key.value = pangramKey; status.textContent = 'Key saved ✓'; status.className = 'ok'; } else status.textContent = 'No key yet.'; });
document.getElementById('save').onclick = async () => {
  const v = key.value.trim();
  await chrome.storage.sync.set({ pangramKey: v });
  status.textContent = v ? 'Key saved ✓' : 'Key removed.'; status.className = v ? 'ok' : '';
};
const auto = document.getElementById('auto');
chrome.storage.sync.get('autoRecheck').then(({ autoRecheck }) => { auto.checked = autoRecheck !== false; });
auto.onchange = () => chrome.storage.sync.set({ autoRecheck: auto.checked });
