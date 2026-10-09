// Offscreen document: fetches the compiled PDF (with Overleaf cookies) and extracts positioned text with pdf.js.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'extract') { extract(msg.pdfUrl).then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) })); return true; }
  if (msg.type === 'highlight') { highlight(msg.pdfUrl, msg.rects).then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) })); return true; }
});

/* Bake the word boxes into a copy of the PDF. rects: [pageIndex][] of {x, y, w, h, score} in PDF points, top-left origin. */
async function highlight(pdfUrl, rects) {
  const r = await fetch(pdfUrl, { credentials: 'include' });
  if (!r.ok) throw new Error(`Could not fetch the PDF (HTTP ${r.status})`);
  const { PDFDocument, rgb, BlendMode } = PDFLib;
  const doc = await PDFDocument.load(await r.arrayBuffer(), { ignoreEncryption: true });
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]; const list = rects[i] || []; if (!list.length) continue;
    const { height } = page.getSize(); const box = page.getMediaBox();
    for (const q of list) {
      const hue = 120 * (1 - Math.max(0, Math.min(1, q.score))) / 360;
      const [cr, cg, cb] = hslToRgb(hue, .85, .5);
      page.drawRectangle({ x: box.x + q.x, y: box.y + height - q.y - q.h, width: q.w, height: q.h, color: rgb(cr, cg, cb), opacity: .38, blendMode: BlendMode.Multiply, borderWidth: 0 });
    }
  }
  doc.setSubject('AI check by Overleaf AI Checker (Pangram): green = human, red = AI');
  const bytes = await doc.save();
  let bin = ''; const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { base64: btoa(bin), size: u8.length };
}
function hslToRgb(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

async function extract(pdfUrl) {
  const r = await fetch(pdfUrl, { credentials: 'include' });
  if (!r.ok) throw new Error(`Could not fetch the PDF (HTTP ${r.status})`);
  const data = await r.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = []; let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent(); const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const t = pdfjsLib.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(t[2], t[3]) || it.height;
      if (it.str.trim()) {
        if (text && !/\s$/.test(text)) text += ' ';
        const start = text.length; text += it.str;
        items.push({ str: it.str, x: t[4], y: t[5], w: it.width, h, start, end: text.length });
      }
      if (it.hasEOL) text += '\n';
    }
    pages.push({ w: vp.width, h: vp.height, items });
  }
  return { pages, text };
}
