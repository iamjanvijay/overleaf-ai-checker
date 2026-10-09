// Offscreen document: fetches the compiled PDF with the user's Overleaf session; pdf.js extracts positioned text;
// pdf-lib writes the highlighted copy.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  const job = msg.type === 'pageCount' ? pageCount(msg.pdfUrl)
            : msg.type === 'extract' ? extract(msg.pdfUrl)
            : msg.type === 'highlight' ? highlight(msg.pdfUrl, msg.rects, msg.note, msg.notePage)
            : null;
  if (!job) return;
  job.then(sendResponse).catch(e => sendResponse({ error: e.message || String(e) }));
  return true;
});

async function fetchPdf(pdfUrl) {
  const r = await fetch(pdfUrl, { credentials: 'include' });
  if (!r.ok) throw new Error(`Could not fetch the PDF (HTTP ${r.status})`);
  return r.arrayBuffer();
}

async function pageCount(pdfUrl) {
  const pdf = await pdfjsLib.getDocument({ data: await fetchPdf(pdfUrl) }).promise;
  return { pages: pdf.numPages };
}

/* Per page: text (for scoring) and positioned text runs in PDF points, top-left origin, scale 1. */
async function extract(pdfUrl) {
  const pdf = await pdfjsLib.getDocument({ data: await fetchPdf(pdfUrl) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent(); const items = []; let text = '';
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
    pages.push({ w: vp.width, h: vp.height, text, items });
  }
  return { pages };
}

/* rects: sparse array by page index of [{x, y, w, h, score, label, confidence}] in PDF points (top-left origin).
   Each run becomes a real PDF Highlight annotation (with its own appearance stream), so viewers render it like a
   highlighter stroke and show the Pangram label + score on hover/click. Pages without rects are untouched. */
async function highlight(pdfUrl, rects, note, notePage) {
  const { PDFDocument, PDFName, PDFString, PDFArray, rgb, StandardFonts } = PDFLib;
  const doc = await PDFDocument.load(await fetchPdf(pdfUrl), { ignoreEncryption: true });
  const ctx = doc.context; const pages = doc.getPages();
  const gsRef = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 }));
  const f = n => +n.toFixed(2);
  for (let i = 0; i < pages.length; i++) {
    const list = rects[i]; if (!list || !list.length) continue;
    const page = pages[i]; const { height } = page.getSize(); const box = page.getMediaBox();
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of('Annots'), annots); }
    for (const q of list) {
      const hue = 120 * (1 - Math.max(0, Math.min(1, q.score))) / 360;
      const [r, g, b] = hslToRgb(hue, .9, .62).map(f);
      const x1 = f(box.x + q.x), y1 = f(box.y + height - q.y - q.h), x2 = f(x1 + q.w), y2 = f(y1 + q.h);
      const ap = ctx.stream(`/GS gs ${r} ${g} ${b} rg ${x1} ${y1} ${f(x2 - x1)} ${f(y2 - y1)} re f`,
        { Type: 'XObject', Subtype: 'Form', BBox: [x1, y1, x2, y2], Resources: { ExtGState: { GS: gsRef } } });
      const text = `${q.label || 'Pangram'}${q.confidence ? ' (' + q.confidence + ' confidence)' : ''} · AI score ${Math.round(q.score * 100)}%`;
      const annot = ctx.obj({
        Type: 'Annot', Subtype: 'Highlight', Rect: [x1, y1, x2, y2], QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
        C: [r, g, b], CA: 1, F: 4, Contents: PDFString.of(text), T: PDFString.of('Pangram AI check'), Subj: PDFString.of('AI check'),
        AP: { N: ctx.register(ap) },
      });
      annots.push(ctx.register(annot));
    }
  }
  if (note && pages[notePage - 1]) {
    const font = await doc.embedFont(StandardFonts.Helvetica); const page = pages[notePage - 1]; const { width, height } = page.getSize(); const box = page.getMediaBox();
    const size = 7.5; const tw = font.widthOfTextAtSize(note, size);
    page.drawRectangle({ x: box.x + (width - tw) / 2 - 6, y: box.y + height - 16, width: tw + 12, height: 12, color: rgb(1, 1, 1), opacity: .85, borderWidth: 0 });
    page.drawText(note, { x: box.x + (width - tw) / 2, y: box.y + height - 12.5, size, font, color: rgb(.15, .15, .15) });
  }
  doc.setSubject('AI check by Overleaf AI Checker (Pangram): green = human, red = AI. Hover a highlight for its score.');
  const bytes = await doc.save();
  let bin = ''; const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { base64: btoa(bin), size: u8.length };
}
function hslToRgb(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
