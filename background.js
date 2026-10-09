// Service worker: talks to Pangram, and asks the offscreen document to extract PDF text.
const PANGRAM_URL = 'https://text.external-api.pangram.com/task';
const CHUNK = 12000;
const cache = new Map();   // textHash -> result

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'analyze') {
    analyze(msg.pdfUrl, sender.tab?.id).then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
    return true;   // async
  }
  if (msg.type === 'extract') {
    (async () => { await ensureOffscreen(); return chrome.runtime.sendMessage({ target: 'offscreen', type: 'extract', pdfUrl: msg.pdfUrl }); })()
      .then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'highlight') {
    (async () => { await ensureOffscreen(); return chrome.runtime.sendMessage({ target: 'offscreen', type: 'highlight', pdfUrl: msg.pdfUrl, rects: msg.rects }); })()
      .then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'analyzeText') {
    analyzeText(msg.text, sender.tab?.id).then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
    return true;
  }
});

async function getKey() {
  const { pangramKey } = await chrome.storage.sync.get('pangramKey');
  return (pangramKey || '').trim();
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Parse the compiled PDF with pdf.js (needs a Worker and DOM APIs).',
    });
  } catch (e) { if (!String(e).includes('single offscreen')) throw e; }
}

function progress(tabId, text) { if (tabId) chrome.tabs.sendMessage(tabId, { target: 'content', type: 'progress', text }).catch(() => {}); }

async function analyze(pdfUrl, tabId) {
  const key = await getKey();
  if (!key) return { error: 'No Pangram API key. Click the extension icon and paste your key.' };
  progress(tabId, 'Reading PDF…');
  await ensureOffscreen();
  const extracted = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'extract', pdfUrl });
  if (!extracted || extracted.error) return { error: extracted?.error || 'Could not read the PDF' };
  const text = extracted.text;
  if (text.split(/\s+/).length < 15) return { error: 'Not enough text in the PDF to analyze.' };
  const h = await sha256(text + '|' + key.slice(-6));
  let scored = cache.get(h);
  if (!scored) {
    progress(tabId, 'Scoring with Pangram…');
    scored = await scoreText(text, key, n => progress(tabId, `Scoring with Pangram… (${n})`));
    cache.set(h, scored);
  }
  return { pages: extracted.pages, text, ...scored };
}

async function analyzeText(text, tabId) {
  const key = await getKey();
  if (!key) return { error: 'No Pangram API key. Click the extension icon and paste your key.' };
  if (text.split(/\s+/).length < 15) return { error: 'Not enough text in the PDF to analyze.' };
  const h = await sha256(text + '|' + key.slice(-6));
  let scored = cache.get(h);
  if (!scored) { progress(tabId, 'Scoring with Pangram…'); scored = await scoreText(text, key, n => progress(tabId, `Scoring… (${n})`)); cache.set(h, scored); }
  return { ...scored };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pangram(method, url, key, body) {
  const r = await fetch(url, { method, headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Pangram HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function scoreChunk(text, key) {
  const { task_id } = await pangram('POST', PANGRAM_URL, key, { text, model: 'pangram-4' });
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const r = await pangram('GET', `${PANGRAM_URL}/${task_id}`, key);
    if (r.stage === 'STAGE_SUCCESS') return r;
    if (r.stage === 'STAGE_FAILED') throw new Error('Pangram task failed');
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error('Pangram timed out');
}

function splitChunks(text, limit) {
  const out = []; let pos = 0;
  while (pos < text.length) {
    let end = Math.min(text.length, pos + limit);
    if (end < text.length) { const cut = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end)); if (cut > pos + limit / 2) end = cut + 1; }
    out.push([pos, text.slice(pos, end)]); pos = end;
  }
  return out;
}

async function scoreText(text, key, onProgress) {
  const windows = []; const tot = { ai: 0, assisted: 0, human: 0, words: 0 };
  const chunks = splitChunks(text, CHUNK); let i = 0;
  for (const [offset, chunk] of chunks) {
    i++; onProgress?.(`chunk ${i}/${chunks.length}`);
    if (chunk.split(/\s+/).length < 15) continue;
    const r = await scoreChunk(chunk, key);
    const n = Math.max(1, (r.windows || []).reduce((a, w) => a + (w.word_count || 0), 0));
    tot.ai += (r.fraction_ai || 0) * n; tot.assisted += (r.fraction_ai_assisted || 0) * n; tot.human += (r.fraction_human || 0) * n; tot.words += n;
    for (const w of r.windows || []) {
      const label = (w.label || '').toLowerCase();
      const conf = { high: 1, medium: .75, low: .5 }[(w.confidence || '').toLowerCase()] ?? .75;
      const assist = +w.ai_assistance_score || 0;
      let score;
      if (label.includes('human') && !label.replace('humanized', '').includes('ai')) score = Math.min(.35, assist);
      else if (label.includes('assist') || label.includes('mixed')) score = .45 + .25 * assist;
      else score = .7 + .3 * conf;
      windows.push({ start: offset + (w.start_index || 0), end: offset + (w.end_index || 0), label: w.label, confidence: w.confidence, score: +score.toFixed(3), humanized: !!w.is_humanized, words: w.word_count });
    }
  }
  const n = Math.max(1, tot.words);
  return { windows, fraction_ai: tot.ai / n, fraction_ai_assisted: tot.assisted / n, fraction_human: tot.human / n, words: tot.words };
}
