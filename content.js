/* Overleaf AI Checker — content script.
   One job: (optionally recompile) → pick a page range → score those pages with Pangram → download the PDF
   with the words on those pages color-coded green (human) → red (AI). Other pages are left untouched. */
(() => {
  if (window.__overleafAiChecker) return; window.__overleafAiChecker = true;
  const $ = (s, r = document) => r.querySelector(s);
  const S = { busy: false, pageCount: 0 };

  const pdfHref = () => { const a = $('a[href*="output.pdf"]'); return a ? a.href : null; };
  const compileBtn = () => $('.compile-button');
  const isCompiling = () => { const b = compileBtn(); return !!b && (b.getAttribute('data-ol-loading') === 'true' || b.disabled); };

  /* ---------- toolbar button + panel ---------- */
  function ensureButton() {
    const bar = $('.toolbar-pdf-left'); if (!bar || $('#oac-btn', bar)) return;
    const b = document.createElement('button');
    b.id = 'oac-btn'; b.type = 'button'; b.className = 'btn btn-link pdf-toolbar-btn oac-btn';
    b.title = 'AI check: download a copy of the PDF with AI-written text highlighted (Pangram)';
    b.innerHTML = '<span class="oac-ico">🤖</span><span class="oac-lbl">AI check</span>';
    b.addEventListener('click', togglePanel);
    bar.appendChild(b);
  }
  function panel() { return $('#oac-panel'); }
  async function togglePanel() {
    const p = panel(); if (p) { p.remove(); return; }
    const host = $('.pdf-viewer') || $('.ide-redesign-pdf-container') || document.body;
    const el = document.createElement('div'); el.id = 'oac-panel';
    el.innerHTML = `
      <div class="oac-head"><span>🤖 AI check (Pangram)</span><button class="oac-x" data-act="close" title="Close">✕</button></div>
      <label class="oac-row"><input type="checkbox" id="oac-compile" checked> Recompile first</label>
      <div class="oac-row">Pages <input id="oac-from" type="number" min="1" value="1"> to <input id="oac-to" type="number" min="1" value="1"> <span id="oac-total" class="oac-muted"></span></div>
      <div class="oac-legend"><span>human</span><span class="oac-bar"></span><span>AI</span></div>
      <button class="oac-go" id="oac-go" data-act="go">⬇ Download highlighted PDF</button>
      <div id="oac-status" class="oac-status"></div>`;
    host.appendChild(el);
    el.addEventListener('click', e => { const act = e.target.closest('[data-act]')?.dataset.act; if (act === 'close') el.remove(); if (act === 'go') run(); });
    refreshPageCount();
  }
  async function refreshPageCount() {
    const href = pdfHref(); const el = panel(); if (!href || !el) return;
    try {
      const r = await chrome.runtime.sendMessage({ target: 'background', type: 'pageCount', pdfUrl: href });
      if (r && r.pages) { S.pageCount = r.pages; $('#oac-total', el).textContent = `of ${r.pages}`; const to = $('#oac-to', el); to.max = r.pages; $('#oac-from', el).max = r.pages; if (+to.value <= 1 || +to.value > r.pages) to.value = r.pages; }
    } catch (e) { /* ignore */ }
  }
  function status(text, cls = '') { const s = $('#oac-status'); if (s) { s.textContent = text; s.className = 'oac-status ' + cls; } }
  function setBusy(b) { S.busy = b; const go = $('#oac-go'); if (go) { go.disabled = b; go.textContent = b ? 'Working…' : '⬇ Download highlighted PDF'; } }

  /* ---------- compile and wait for the fresh PDF ---------- */
  async function recompile() {
    const btn = compileBtn(); if (!btn) throw new Error('Could not find Overleaf\'s Recompile button.');
    const before = pdfHref(); btn.click();
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 1500));
    while (Date.now() - t0 < 180000) {
      if (!isCompiling() && pdfHref() && pdfHref() !== before) return pdfHref();
      if (!isCompiling() && Date.now() - t0 > 8000 && pdfHref()) return pdfHref();   // compile finished, output unchanged
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Compile did not finish in time.');
  }

  /* ---------- main flow ---------- */
  async function run() {
    if (S.busy) return;
    const el = panel(); if (!el) return;
    const from = Math.max(1, parseInt($('#oac-from', el).value, 10) || 1);
    const to = Math.max(from, parseInt($('#oac-to', el).value, 10) || from);
    setBusy(true);
    try {
      let href = pdfHref();
      if ($('#oac-compile', el).checked) { status('Recompiling…'); href = await recompile(); await refreshPageCount(); }
      if (!href) throw new Error('No compiled PDF found. Compile first.');
      status(`Reading pages ${from}–${to} and scoring with Pangram…`);
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'highlightRange', pdfUrl: href, from, to });
      if (!res || res.error) throw new Error(res?.error || 'Unknown error');
      const bin = atob(res.base64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }));
      const name = (document.title.split(' - ')[0] || 'document').replace(/[^\w.-]+/g, '_') + `-ai-check-p${res.from}-${res.to}.pdf`;
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      const s = res.summary;
      status(`Done · pages ${res.from}–${res.to}: ${Math.round(s.fraction_ai * 100)}% AI · ${Math.round(s.fraction_ai_assisted * 100)}% AI-assisted · ${Math.round(s.fraction_human * 100)}% human (${s.words} words)`, 'ok');
    } catch (e) { status('Error: ' + (e.message || e), 'err'); }
    setBusy(false);
  }

  chrome.runtime.onMessage.addListener(msg => { if (msg.target === 'content' && msg.type === 'progress') status(msg.text); });
  const mo = new MutationObserver(() => ensureButton());
  mo.observe(document.body, { childList: true, subtree: true });
  ensureButton();
})();
