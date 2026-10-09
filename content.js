/* Overleaf AI Checker — content script.
   Adds an "AI check" button to the PDF toolbar; paints word-level overlays (green = human, red = AI) on the pdf.js pages. */
(() => {
  if (window.__pangramOverleaf) return; window.__pangramOverleaf = true;
  const S = { result: null, visible: true, busy: false, pdfHref: null, stale: false, autoRecheck: true };
  try {
    chrome.storage.sync.get('autoRecheck').then(v => { if (v && v.autoRecheck !== undefined) S.autoRecheck = !!v.autoRecheck; });
    chrome.storage.onChanged.addListener(ch => { if (ch.autoRecheck) S.autoRecheck = !!ch.autoRecheck.newValue; });
  } catch (e) { /* storage unavailable (e.g. test harness) */ }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const color = sc => sc == null ? 'rgba(140,140,140,.28)' : `hsla(${Math.round(120 * (1 - Math.max(0, Math.min(1, sc))))}, 85%, 50%, .38)`;

  /* ---------- toolbar button ---------- */
  function ensureButton() {
    const bar = $('.toolbar-pdf-left'); if (!bar || $('#pg-ai-btn', bar)) return;
    const b = document.createElement('button');
    b.id = 'pg-ai-btn'; b.type = 'button'; b.className = 'btn btn-link pdf-toolbar-btn pg-btn';
    b.title = 'AI check: score the PDF text with Pangram and highlight AI-written words. Click again to refresh.';
    b.innerHTML = '<span class="pg-ico">🤖</span><span class="pg-lbl">AI check</span>';
    b.addEventListener('click', run);
    bar.appendChild(b);
    const t = document.createElement('button');
    t.id = 'pg-toggle-btn'; t.type = 'button'; t.className = 'btn btn-link pdf-toolbar-btn pg-btn'; t.hidden = true;
    t.addEventListener('click', () => { S.visible = !S.visible; paint(); renderStrip(); updateToggle(); });
    bar.appendChild(t);
    setBusy(S.busy, S.busyText); updateToggle();
  }
  function updateToggle() {
    const t = $('#pg-toggle-btn'); if (!t) return;
    t.hidden = !S.result; t.innerHTML = S.visible ? '<span class="pg-ico">👁</span><span class="pg-lbl">Hide</span>' : '<span class="pg-ico">👁‍🗨</span><span class="pg-lbl">Show</span>';
    t.title = S.visible ? 'Hide the AI highlights (result is kept)' : 'Show the AI highlights';
  }
  function setBusy(busy, text) {
    S.busy = busy; S.busyText = text; const b = $('#pg-ai-btn'); if (!b) return;
    b.classList.toggle('pg-busy', busy); b.querySelector('.pg-lbl').textContent = busy ? (text || 'Analyzing…') : 'AI check';
  }

  /* ---------- PDF location & pages ---------- */
  const pdfHref = () => { const a = $('a[href*="output.pdf"]'); return a ? a.href : null; };
  const pageEls = () => $$('.pdfViewer .page[data-page-number]');

  /* Fallback text source when the PDF cannot be parsed: the pdf.js text layer of rendered pages. */
  function extractFromTextLayer() {
    const pages = []; let text = '';
    for (const pg of pageEls()) {
      const n = +pg.dataset.pageNumber; const pr = pg.getBoundingClientRect(); const items = [];
      for (const sp of $$('.textLayer > span', pg)) {
        const str = sp.textContent; if (!str.trim()) continue;
        const r = sp.getBoundingClientRect(); if (!r.width) continue;
        if (text && !/\s$/.test(text)) text += ' ';
        const start = text.length; text += str;
        items.push({ str, x: r.left - pr.left, y: r.bottom - pr.top, w: r.width, h: r.height, start, end: text.length });
      }
      pages[n - 1] = { w: pr.width, h: pr.height, items };
      text += '\n';
    }
    return { pages, text };
  }

  /* ---------- run ---------- */
  async function run() {
    if (S.busy) return;
    const href = pdfHref();
    if (!href) return notify('No compiled PDF found. Compile first.');
    setBusy(true, 'Analyzing…');
    try {
      let res = await chrome.runtime.sendMessage({ target: 'background', type: 'analyze', pdfUrl: href });
      if (res?.error && /read the PDF|fetch the PDF/i.test(res.error) && pageEls().some(p => $('.textLayer', p))) {
        // fall back to the on-screen text layer
        const ex = extractFromTextLayer();
        res = await chrome.runtime.sendMessage({ target: 'background', type: 'analyzeText', text: ex.text });
        if (!res?.error) { res.pages = ex.pages; res.text = ex.text; }
      }
      if (!res || res.error) throw new Error(res?.error || 'Unknown error');
      S.result = res; S.pdfHref = href; S.stale = false; S.visible = true;
      paint(); renderStrip(); updateToggle();
    } catch (e) { notify('Pangram: ' + (e.message || e)); }
    setBusy(false);
  }

  /* ---------- overlays ---------- */
  const UNSCORED = { label: 'Changed since the last check — not scored yet', confidence: '', score: null };
  function clearOverlays() { $$('.pg-overlay').forEach(o => o.remove()); }
  /* word boxes in PDF points (top-left origin, scale 1), computed once per result */
  function wordRects() {
    if (S.result._rects) return S.result._rects;
    const wins = S.result.windows.slice().sort((a, b) => a.start - b.start);
    const winAt = pos => { for (const w of wins) if (pos >= w.start && pos < w.end) return w; return null; };
    const out = S.result.pages.map(page => {
      const list = [];
      for (const it of page.items) {
        const re = /\S+/g; let m;
        while ((m = re.exec(it.str))) {
          let w = winAt(it.start + m.index);
          if (!w) { if (!S.result.partial) continue; w = UNSCORED; }
          const x0 = it.x + it.w * (m.index / it.str.length), x1 = it.x + it.w * ((m.index + m[0].length) / it.str.length);
          list.push({ x: x0, y: it.y - it.h, w: x1 - x0, h: it.h * 1.25, score: w.score, win: w });
        }
      }
      return list;
    });
    S.result._rects = out; return out;
  }
  function paint() {
    clearOverlays(); if (!S.result || !S.visible) return;
    const rects = wordRects();
    for (const pg of pageEls()) {
      const idx = +pg.dataset.pageNumber - 1; const page = S.result.pages[idx]; if (!page) continue;
      const scale = pg.clientWidth / page.w;
      const ov = document.createElement('div'); ov.className = 'pg-overlay'; ov._rects = [];
      for (const q of rects[idx]) {
        const d = document.createElement('div'); d.className = 'pg-w';
        const rect = { l: q.x * scale, t: q.y * scale, w: q.w * scale, h: q.h * scale, win: q.win };
        d.style.cssText = `left:${rect.l}px;top:${rect.t}px;width:${rect.w}px;height:${rect.h}px;background:${color(q.score)}`;
        ov.appendChild(d); ov._rects.push(rect);
      }
      pg.appendChild(ov);
    }
  }
  /* After a recompile: carry the existing scores over to the new PDF by matching each scored segment's text. */
  async function remap(href) {
    S.remapping = true; S.pdfHref = href; clearOverlays();
    try {
      let ex = await chrome.runtime.sendMessage({ target: 'background', type: 'extract', pdfUrl: href });
      if (!ex || ex.error) {
        await new Promise(r => setTimeout(r, 800));   // give the viewer time to render its text layer
        ex = extractFromTextLayer();
      }
      const old = S.result, oldText = old.text || '';
      const wins = old.windows.slice().sort((a, b) => a.start - b.start);
      const kept = []; let cursor = 0;
      for (const w of wins) {
        const seg = oldText.slice(w.start, w.end).trim(); if (seg.length < 20) continue;
        let i = ex.text.indexOf(seg, cursor); if (i < 0) i = ex.text.indexOf(seg);
        if (i < 0) continue;
        kept.push({ ...w, start: i, end: i + seg.length }); cursor = i + seg.length;
      }
      S.result = { ...old, pages: ex.pages, text: ex.text, windows: kept, _rects: null, partial: { kept: kept.length, total: wins.length } };
      S.remapping = false; paint(); renderStrip();
      if (S.autoRecheck && kept.length < wins.length) run();
    } catch (e) { S.remapping = false; S.result = null; clearOverlays(); renderStrip(); updateToggle(); notify('Could not carry scores over: ' + (e.message || e)); }
  }
  async function downloadHighlighted() {
    if (!S.result || S.busy) return;
    const href = S.pdfHref || pdfHref(); if (!href) return notify('No compiled PDF found.');
    setBusy(true, 'Building PDF…');
    try {
      const rects = wordRects().map(list => list.map(({ x, y, w, h, score }) => ({ x, y, w, h, score })));
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'highlight', pdfUrl: href, rects });
      if (!res || res.error) throw new Error(res?.error || 'Could not build the PDF');
      const bin = atob(res.base64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }));
      const name = (document.title.split(' - ')[0] || 'document').replace(/[^\w.-]+/g, '_') + '-ai-check.pdf';
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { notify('Download failed: ' + (e.message || e)); }
    setBusy(false);
  }
  // tooltip via hit-testing (overlay has pointer-events: none so Overleaf's selection and sync still work)
  const tip = document.createElement('div'); tip.className = 'pg-tip'; tip.hidden = true; document.documentElement.appendChild(tip);
  document.addEventListener('mousemove', e => {
    if (!S.result || !S.visible) { tip.hidden = true; return; }
    const pg = e.target.closest?.('.pdfViewer .page'); const ov = pg && $('.pg-overlay', pg);
    if (!ov) { tip.hidden = true; return; }
    const pr = pg.getBoundingClientRect(); const x = e.clientX - pr.left, y = e.clientY - pr.top;
    const hit = ov._rects.find(r => x >= r.l && x <= r.l + r.w && y >= r.t && y <= r.t + r.h);
    if (!hit) { tip.hidden = true; return; }
    const w = hit.win;
    tip.textContent = w.score == null ? w.label : `${w.label} · ${w.confidence} confidence${w.humanized ? ' · humanized' : ''} · AI score ${Math.round(w.score * 100)}%`;
    tip.style.background = color(w.score).replace('.38', '.96');
    tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 16) + 'px'; tip.hidden = false;
  }, true);

  /* ---------- summary strip ---------- */
  function renderStrip() {
    let strip = $('#pg-strip');
    const host = $('.pdf-viewer') || $('.pdfjs-viewer-outer')?.parentElement; if (!host) return;
    if (!strip) { strip = document.createElement('div'); strip.id = 'pg-strip'; host.appendChild(strip); }
    if (!S.result) { strip.remove(); return; }
    const r = S.result;
    strip.innerHTML = `<span class="pg-lbl2">Pangram:</span><span class="pg-hum">human</span><span class="pg-bar"></span><span class="pg-ai">AI</span>
      <b>${Math.round(r.fraction_ai * 100)}% AI</b> · ${Math.round(r.fraction_ai_assisted * 100)}% AI-assisted · ${Math.round(r.fraction_human * 100)}% human
      <small>(${r.words} words · hover for details)</small>${S.result.partial ? `<span class="pg-stale">PDF changed: ${S.result.partial.kept} of ${S.result.partial.total} segments kept, grey = not scored yet${S.autoRecheck ? ' · re-checking…' : ' — click AI check to re-score'}</span>` : ''}
      <button class="pg-x" data-act="download" title="Download a copy of the PDF with the highlights baked in">⬇ PDF</button><button class="pg-x" data-act="toggle">${S.visible ? 'hide' : 'show'}</button><button class="pg-x" data-act="close">✕</button>`;
    strip.onclick = e => {
      const act = e.target.dataset.act; if (!act) return;
      if (act === 'download') downloadHighlighted();
      if (act === 'toggle') { S.visible = !S.visible; paint(); renderStrip(); updateToggle(); }
      if (act === 'close') { S.result = null; clearOverlays(); renderStrip(); updateToggle(); }
    };
  }
  function notify(msg) {
    let n = $('#pg-toast'); if (!n) { n = document.createElement('div'); n.id = 'pg-toast'; document.body.appendChild(n); }
    n.textContent = msg; n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => n.hidden = true, 4000);
  }

  /* ---------- keep up with Overleaf's React re-renders, zoom and recompiles ---------- */
  let raf = 0;
  const mo = new MutationObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      ensureButton();
      if (!S.result) return;
      const href = pdfHref();
      if (href && S.pdfHref && href !== S.pdfHref && !S.remapping) { remap(href); return; }
      if (!S.remapping && pageEls().some(p => !$('.pg-overlay', p))) paint();
      if (!$('#pg-strip')) renderStrip();
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
  const ro = new ResizeObserver(() => { if (S.result && !S.stale) paint(); });
  setInterval(() => pageEls().forEach(p => ro.observe(p)), 2000);
  chrome.runtime.onMessage.addListener(msg => { if (msg.target === 'content' && msg.type === 'progress') setBusy(true, msg.text); });
  ensureButton();
})();
