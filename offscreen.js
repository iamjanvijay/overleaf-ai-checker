// Offscreen document: fetches the compiled PDF with the user's Overleaf session; pdf.js extracts positioned text;
// pdf-lib writes the highlighted copy.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  const job = msg.type === 'pageCount' ? pageCount(msg.pdfUrl)
            : msg.type === 'extract' ? extract(msg.pdfUrl)
            : msg.type === 'highlight' ? highlight(msg.pdfUrl, msg.rects, msg.note, msg.notePage, !!msg.popups)
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

/* Per page: clean prose text (for scoring) plus positioned text runs in PDF points (top-left origin, scale 1).
   Cleaning, so Pangram sees natural paragraphs rather than PDF layout artefacts:
   - visual lines are re-joined into paragraphs (blank line only at real paragraph breaks: large vertical gap,
     first-line indent, or column/page change);
   - words hyphenated across a line break are re-joined ("tran-" + "script" -> "transcript");
   - equations, tables of numbers, page numbers and running headers/footers are left out of the text
     (they stay unhighlighted; their items get start = end = -1). */
async function extract(pdfUrl) {
  const pdf = await pdfjsLib.getDocument({ data: await fetchPdf(pdfUrl) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent(); const its = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const t = pdfjsLib.Util.transform(vp.transform, it.transform);
      its.push({ str: it.str, x: t[4], y: t[5], w: it.width, h: Math.hypot(t[2], t[3]) || it.height, eol: !!it.hasEOL, start: -1, end: -1 });
    }
    const H = vp.height;
    const vocab = new Set(); for (const it of its) for (const w of it.str.replace(/[A-Za-z]+-\s*$/, '').toLowerCase().match(/[a-z]{3,}/g) || []) vocab.add(w);   // fragments before a line-end hyphen don't count
    const isMathish = str => { const ns = str.replace(/\s/g, ''); if (!ns) return true; const letters = (str.match(/[A-Za-z]/g) || []).length; const words = (str.match(/[A-Za-z]{3,}/g) || []).length; return letters / ns.length < 0.45 && words < 2; };
    for (let k = 0; k < its.length; k++) {
      const it = its[k]; const ns = it.str.replace(/\s/g, '');
      const edge = it.y < H * 0.06 || it.y > H * 0.94;
      const nxt = its[k + 1]; it.eol = it.eol || !nxt || Math.abs(nxt.y - it.y) > (it.h || 10) * 0.5;   // geometric line end too
      const wholeLine = (k === 0 || its[k - 1].eol) && it.eol;
      it.skip = !ns || (edge && ns.length < 60) || (isMathish(it.str) && (ns.length >= 10 || wholeLine));   // short inline numbers are kept
    }
    let text = '', pending = null, joinTight = false, lineStartX = null;
    const nextKept = k => { for (let j = k + 1; j < its.length; j++) if (!its[j].skip) return its[j]; return null; };
    for (let k = 0; k < its.length; k++) {
      const it = its[k]; if (it.skip) continue;
      let str = it.str;
      if (pending === 'para') { text = text.replace(/\s+$/, '') + '\n\n'; }
      else if (pending === 'soft') { if (!joinTight && !/\s$/.test(text)) text += ' '; }
      else if (text && !/\s$/.test(text) && !/^\s/.test(str)) text += ' ';
      if (lineStartX === null || pending) lineStartX = it.x;
      pending = null; joinTight = false;
      it.start = text.length;
      if (it.eol) {
        const nx = nextKept(k);
        if (nx && /[A-Za-z]-$/.test(str) && /^[a-z]/.test(nx.str)) {
          const frag = (str.match(/([A-Za-z]+)-$/) || [])[1] || '';
          joinTight = true;
          if (!(frag.length >= 3 && vocab.has(frag.toLowerCase()))) str = str.slice(0, -1);   // "tran-"+"script" -> "transcript"; "graph-"+"agreement" keeps its hyphen
        }
      }
      text += str; it.end = text.length;
      if (it.eol) {
        const nx = nextKept(k);
        if (!nx) pending = 'para';
        else {
          const gap = nx.y - it.y, indent = nx.x - lineStartX, h = it.h || 10;
          const sizeChange = Math.abs(nx.h - it.h) > h * 0.15;                 // heading <-> body text
          const columnOrPageJump = gap < -h * 0.5;
          const newPara = sizeChange || gap > h * 1.65 || (indent > h * 0.8 && indent < h * 4) || (/[.!?:]["')\]]?$/.test(str) && columnOrPageJump && indent > h * 4);
          pending = newPara ? 'para' : 'soft';
          if (pending === 'para') joinTight = false;
        }
      }
    }
    pages.push({ w: vp.width, h: vp.height, text: text.trim(), items: its.filter(it => !it.skip).map(({ str, x, y, w, h, start, end }) => ({ str, x, y, w, h, start, end })) });
  }
  return { pages };
}

/* rects: sparse array by page index of [{x, y, w, h, score, label, confidence}] in PDF points (top-left origin).
   Each run becomes a real PDF Highlight annotation (with its own appearance stream), so viewers render it like a
   highlighter stroke and show the Pangram label + score on hover/click. Pages without rects are untouched. */
async function highlight(pdfUrl, rects, note, notePage, popups) {
  const { PDFDocument, PDFName, PDFString, PDFArray, rgb, StandardFonts } = PDFLib;
  const doc = await PDFDocument.load(await fetchPdf(pdfUrl), { ignoreEncryption: true });
  const ctx = doc.context; const pages = doc.getPages();
  const gsRef = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Multiply', CA: .55, ca: .55 }));
  const f = n => +n.toFixed(2);
  for (let i = 0; i < pages.length; i++) {
    const list = rects[i]; if (!list || !list.length) continue;
    const page = pages[i]; const { height } = page.getSize(); const box = page.getMediaBox();
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of('Annots'), annots); }
    for (const q of list) {
      const hue = 120 * (1 - Math.max(0, Math.min(1, q.score))) / 360;
      const [r, g, b] = hslToRgb(hue, .95, .78).map(f);   // pastel highlighter tint
      const x1 = f(box.x + q.x), y1 = f(box.y + height - q.y - q.h), x2 = f(x1 + q.w), y2 = f(y1 + q.h);
      const ap = ctx.stream(`/GS gs ${r} ${g} ${b} rg ${x1} ${y1} ${f(x2 - x1)} ${f(y2 - y1)} re f`,
        { Type: 'XObject', Subtype: 'Form', BBox: [x1, y1, x2, y2], Resources: { ExtGState: { GS: gsRef } } });
      const conf = q.confidence ? ` (${String(q.confidence).toLowerCase()} confidence)` : '';
      const detail = q.label === 'AI-assisted' && q.assist ? ` ${Math.round(q.assist * 100)}% assisted` : '';
      const text = `${q.word ? q.word + ': ' : ''}${q.label}${detail}${conf}`.replace(/[^\x20-\x7e]/g, '?');   // e.g. "transcript: AI (high confidence)"
      const annot = ctx.obj({
        Type: 'Annot', Subtype: 'Highlight', Rect: [x1, y1, x2, y2], QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
        C: [r, g, b], CA: .55, F: 4, Contents: PDFString.of(text),
        AP: { N: ctx.register(ap) },
      });
      const annotRef = ctx.register(annot);
      annots.push(annotRef);
      if (popups) {   // optional: Chrome's viewer shows Popup annotations as a fixed 200x200 pt yellow box on hover
        const popup = ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [x1, f(y2 + 2), f(x1 + 120), f(y2 + 20)], Parent: annotRef, Open: false, F: 28 });
        const popupRef = ctx.register(popup); annot.set(PDFName.of('Popup'), popupRef); annots.push(popupRef);
      }
    }
  }
  if (note && pages[notePage - 1]) {
    const font = await doc.embedFont(StandardFonts.Helvetica); const page = pages[notePage - 1]; const { width, height } = page.getSize(); const box = page.getMediaBox();
    const size = 7.5; const tw = font.widthOfTextAtSize(note, size);
    page.drawRectangle({ x: box.x + (width - tw) / 2 - 6, y: box.y + height - 16, width: tw + 12, height: 12, color: rgb(1, 1, 1), opacity: .85, borderWidth: 0 });
    page.drawText(note, { x: box.x + (width - tw) / 2, y: box.y + height - 12.5, size, font, color: rgb(.15, .15, .15) });
  }
  doc.setSubject('AI check by Overleaf AI Checker (Pangram): green = human, yellow = AI-assisted, red = AI.');
  const bytes = await doc.save();
  let bin = ''; const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { base64: btoa(bin), size: u8.length };
}
function hslToRgb(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
