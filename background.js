// Service worker: scores the chosen pages with Pangram and asks the offscreen document to parse/highlight the PDF.
const PANGRAM_URL = 'https://text.external-api.pangram.com/task';
const CHUNK = 12000;
const cache = new Map();   // hash -> scored result

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  const tabId = sender.tab?.id;
  const job = msg.type === 'pageCount' ? pageCount(msg.pdfUrl)
            : msg.type === 'highlightRange' ? highlightRange(msg.pdfUrl, msg.from, msg.to, tabId)
            : null;
  if (!job) return;
  job.then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
  return true;   // async response
});

async function getKey() { const { pangramKey } = await chrome.storage.sync.get('pangramKey'); return (pangramKey || '').trim(); }

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Parse the compiled PDF with pdf.js and write the highlighted copy with pdf-lib.' });
  } catch (e) { if (!String(e).includes('single offscreen')) throw e; }
}
const offscreen = async (payload) => { await ensureOffscreen(); const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...payload }); if (!r || r.error) throw new Error(r?.error || 'PDF processing failed'); return r; };
const progress = (tabId, text) => { if (tabId) chrome.tabs.sendMessage(tabId, { target: 'content', type: 'progress', text }).catch(() => {}); };

async function pageCount(pdfUrl) { const r = await offscreen({ type: 'pageCount', pdfUrl }); return { pages: r.pages }; }

async function highlightRange(pdfUrl, from, to, tabId) {
  const key = await getKey();
  if (!key) return { error: 'No Pangram API key. Click the extension icon and paste your key.' };
  progress(tabId, 'Reading the PDF…');
  const ex = await offscreen({ type: 'extract', pdfUrl });          // { pages: [{ w, h, text, items:[{str,x,y,w,h,start,end}] }] }
  const n = ex.pages.length;
  from = Math.max(1, Math.min(from || 1, n)); to = Math.max(from, Math.min(to || n, n));
  // Build the text of the selected pages; remember each page's offset in it.
  let text = ''; const offsets = [];
  for (let p = from; p <= to; p++) { offsets[p] = text.length; text += ex.pages[p - 1].text + '\n'; }
  if (text.split(/\s+/).filter(Boolean).length < 15) return { error: `Pages ${from}–${to} contain too little text to analyze.` };
  const h = await sha256(text + '|' + key.slice(-6));
  let scored = cache.get(h);
  if (!scored) { scored = await scoreText(text, key, s => progress(tabId, `Scoring with Pangram… ${s}`)); cache.set(h, scored); }
  // Highlight runs (PDF points, top-left origin) for the selected pages only: consecutive words on the same line
  // that share a score are merged into one continuous stroke, so the result reads like a highlighter pen.
  const wins = scored.windows.slice().sort((a, b) => a.start - b.start);
  const winAt = pos => { for (const w of wins) if (pos >= w.start && pos < w.end) return w; return null; };
  const rects = [];
  for (let p = from; p <= to; p++) {
    const page = ex.pages[p - 1]; const runs = [];
    for (const it of page.items) {
      const re = /\S+/g; let m;
      while ((m = re.exec(it.str))) {
        const w = winAt(offsets[p] + it.start + m.index); if (!w) continue;
        const x0 = it.x + it.w * (m.index / it.str.length), x1 = it.x + it.w * ((m.index + m[0].length) / it.str.length);
        const last = runs[runs.length - 1];
        if (last && last.win === w && Math.abs(last.base - it.y) < it.h * 0.3 && x0 - last.x1 < it.h * 0.9 && x0 >= last.x0) { last.x1 = Math.max(last.x1, x1); last.h = Math.max(last.h, it.h); continue; }
        runs.push({ x0, x1, base: it.y, h: it.h, win: w });
      }
    }
    rects[p - 1] = runs.map(r => ({ x: r.x0 - 0.5, y: r.base - r.h * 0.74, w: r.x1 - r.x0 + 1, h: r.h * 0.92, score: r.win.score, label: r.win.label, confidence: r.win.confidence }));
  }
  progress(tabId, 'Writing the highlighted PDF…');
  const note = `Pangram AI check (pages ${from}–${to}): ${Math.round(scored.fraction_ai * 100)}% AI · ${Math.round(scored.fraction_ai_assisted * 100)}% AI-assisted · ${Math.round(scored.fraction_human * 100)}% human. Green = human, yellow = AI-assisted, red = AI.`;
  const out = await offscreen({ type: 'highlight', pdfUrl, rects, note, notePage: from });
  return { base64: out.base64, from, to, summary: scored };
}

async function sha256(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }

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
    i++; onProgress?.(chunks.length > 1 ? `(part ${i}/${chunks.length})` : '');
    if (chunk.split(/\s+/).filter(Boolean).length < 15) continue;
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
      windows.push({ start: offset + (w.start_index || 0), end: offset + (w.end_index || 0), label: w.label, confidence: w.confidence, score: +score.toFixed(3) });
    }
  }
  const n = Math.max(1, tot.words);
  return { windows, fraction_ai: tot.ai / n, fraction_ai_assisted: tot.assisted / n, fraction_human: tot.human / n, words: tot.words };
}
