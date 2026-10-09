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

/* rects: sparse array by page index of [{x, y, w, h, score}] in PDF points (top-left origin). Only those pages get drawn on. */
async function highlight(pdfUrl, rects, note, notePage) {
  const { PDFDocument, rgb, BlendMode, StandardFonts } = PDFLib;
  const doc = await PDFDocument.load(await fetchPdf(pdfUrl), { ignoreEncryption: true });
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const list = rects[i]; if (!list || !list.length) continue;
    const page = pages[i]; const { height } = page.getSize(); const box = page.getMediaBox();
    for (const q of list) {
      const hue = 120 * (1 - Math.max(0, Math.min(1, q.score))) / 360;
      const [r, g, b] = hslToRgb(hue, .85, .5);
      page.drawRectangle({ x: box.x + q.x, y: box.y + height - q.y - q.h, width: q.w, height: q.h, color: rgb(r, g, b), opacity: .38, blendMode: BlendMode.Multiply, borderWidth: 0 });
    }
  }
  if (note && pages[notePage - 1]) {
    const font = await doc.embedFont(StandardFonts.Helvetica); const page = pages[notePage - 1]; const { width, height } = page.getSize(); const box = page.getMediaBox();
    const size = 7.5; const tw = font.widthOfTextAtSize(note, size);
    page.drawRectangle({ x: box.x + (width - tw) / 2 - 6, y: box.y + height - 16, width: tw + 12, height: 12, color: rgb(1, 1, 1), opacity: .85, borderWidth: 0 });
    page.drawText(note, { x: box.x + (width - tw) / 2, y: box.y + height - 12.5, size, font, color: rgb(.15, .15, .15) });
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
