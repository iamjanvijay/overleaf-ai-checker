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
  // One highlight per word (PDF points, top-left origin) for the selected pages only. Consecutive words on the
  // same line with the same score are tiled edge-to-edge so the stroke looks continuous, but each word keeps its
  // own annotation (hover shows the word and its Pangram score).
  const wins = sentenceSmooth(text, scored.windows);
  const winAt = pos => { for (const w of wins) if (pos >= w.start && pos < w.end) return w; return null; };
  const rects = [];
  for (let p = from; p <= to; p++) {
    const page = ex.pages[p - 1]; const words = [];
    for (const it of page.items) {
      const re = /\S+/g; let m;
      while ((m = re.exec(it.str))) {
        const w = winAt(offsets[p] + it.start + m.index); if (!w) continue;
        const x0 = it.x + it.w * (m.index / it.str.length), x1 = it.x + it.w * ((m.index + m[0].length) / it.str.length);
        words.push({ word: m[0], x0, x1, base: it.y, h: it.h, win: w });
      }
    }
    for (let k = 0; k < words.length; k++) {
      const a = words[k], b = words[k + 1];
      const sameLine = b && b.win === a.win && Math.abs(b.base - a.base) < a.h * 0.3 && b.x0 - a.x1 < a.h * 0.9 && b.x0 >= a.x0;
      a.x1e = sameLine ? b.x0 : a.x1 + 0.5;                     // extend to the next word so the stroke is continuous
      const prev = words[k - 1];
      a.x0e = prev && prev.x1e === a.x0 ? a.x0 : a.x0 - 0.5;
    }
    rects[p - 1] = words.map(q => ({ x: q.x0e, y: q.base - q.h * 0.74, w: q.x1e - q.x0e, h: q.h * 0.92, score: q.win.score, label: q.win.label, confidence: q.win.confidence, word: q.word }));
  }
  progress(tabId, 'Writing the highlighted PDF…');
  const note = `Pangram AI check (pages ${from}–${to}): ${Math.round(scored.fraction_ai * 100)}% AI · ${Math.round(scored.fraction_ai_assisted * 100)}% AI-assisted · ${Math.round(scored.fraction_human * 100)}% human. Green = human, yellow = AI-assisted, red = AI.`;
  const { chromePopups } = await chrome.storage.sync.get('chromePopups');
  const out = await offscreen({ type: 'highlight', pdfUrl, rects, note, notePage: from, popups: !!chromePopups });
  return { base64: out.base64, from, to, summary: scored };
}

/* Give every sentence one score: the segment that covers most of its characters. Removes single-word colour flips
   at segment edges. Returns merged, sorted windows. */
function sentenceSmooth(text, windows) {
  const wins = windows.slice().sort((a, b) => a.start - b.start);
  if (!wins.length) return wins;
  const sentences = []; const re = /[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)\s*/g; let m;
  while ((m = re.exec(text)) && m[0]) sentences.push({ start: m.index, end: m.index + m[0].length });
  const out = [];
  for (const st of sentences) {
    let best = null, bestCov = 0;
    for (const w of wins) { const cov = Math.min(st.end, w.end) - Math.max(st.start, w.start); if (cov > bestCov) { bestCov = cov; best = w; } }
    if (!best) continue;
    const last = out[out.length - 1];
    if (last && last.src === best && last.end >= st.start - 2) last.end = st.end;
    else out.push({ start: st.start, end: st.end, label: best.label, confidence: best.confidence, score: best.score, src: best });
  }
  return out.map(({ src, ...w }) => w);
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
    let cursor = 0;
    for (const w of r.windows || []) {
      // Anchor the segment by its own text (Pangram's indices can drift from our text by a few characters);
      // fall back to the reported indices when the text is not found verbatim.
      let s0 = w.start_index || 0, s1 = w.end_index || 0;
      const wt = (w.text || '').trim();
      if (wt.length >= 20) { const probe = wt.slice(0, 60); let i = chunk.indexOf(probe, cursor); if (i < 0) i = chunk.indexOf(probe); if (i >= 0) { s0 = i; const j = chunk.indexOf(wt.slice(-40), i); s1 = j >= 0 ? j + wt.slice(-40).length : i + wt.length; cursor = s1; } }
      const label = (w.label || '').toLowerCase();
      const conf = { high: 1, medium: .75, low: .5 }[(w.confidence || '').toLowerCase()] ?? .75;
      const assist = +w.ai_assistance_score || 0;
      let score;
      if (label.includes('human') && !label.replace('humanized', '').includes('ai')) score = Math.min(.35, assist);
      else if (label.includes('assist') || label.includes('mixed')) score = .45 + .25 * assist;
      else score = .7 + .3 * conf;
      windows.push({ start: offset + s0, end: offset + s1, label: w.label, confidence: w.confidence, score: +score.toFixed(3) });
    }
  }
  const n = Math.max(1, tot.words);
  return { windows, fraction_ai: tot.ai / n, fraction_ai_assisted: tot.assisted / n, fraction_human: tot.human / n, words: tot.words };
}
