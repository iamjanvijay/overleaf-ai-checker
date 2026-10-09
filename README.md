# Overleaf AI Checker (Chrome extension)

Adds an **🤖 AI check** button to Overleaf's PDF toolbar. It scores the currently compiled PDF with
[Pangram](https://www.pangram.com) and paints every word on a green (human) → red (AI) scale, with a summary
strip, hover details, show/hide, and a **download of the PDF with the highlights baked in**.

## Features
- One click on the compiled PDF; click again to refresh. Works on the full PDF (all pages, not only visible ones).
- Word-level color coding; hover any word for label, confidence and AI score.
- Show/Hide toggle (toolbar 👁 button or the strip) once a result exists.
- After a recompile, unchanged paragraphs keep their colors immediately (segments are re-matched by text);
  edited text shows grey until re-scored. "Auto re-check after compile" is on by default (popup option).
- ⬇ highlighted PDF: downloads a copy of the PDF with the colored boxes drawn in (pdf-lib, multiply blend).
- Your Pangram API key is entered in the popup, stored in `chrome.storage.sync`, sent only to Pangram.

## Install (unpacked, for development)
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose this folder.
2. Click the extension icon → paste your Pangram API key → Save.
3. Open an Overleaf project, compile, click **🤖 AI check** in the PDF toolbar.

## Architecture (Manifest V3)
| File | Role |
|---|---|
| `content.js` / `content.css` | Injects the toolbar button, strip, tooltip; paints overlays on `.pdfViewer .page` elements; re-maps scores after recompiles. |
| `background.js` | Service worker. Calls Pangram (`/task` + polling), chunks long documents, caches results, relays to the offscreen document. |
| `offscreen.html` / `offscreen.js` | Offscreen document: fetches the compiled PDF with the user's Overleaf session, extracts positioned text with pdf.js, and builds the highlighted PDF with pdf-lib. |
| `popup.html` / `popup.js` | API key entry and the auto re-check option. |
| `pdf.min.js`, `pdf.worker.min.js` | pdf.js 3.11.174 (Apache-2.0). |
| `pdf-lib.min.js` | pdf-lib 1.17.1 (MIT). |

Permissions: `storage` (API key + option), `offscreen` (pdf.js worker), host access to `www.overleaf.com`
(read the compiled PDF) and `text.external-api.pangram.com` (scoring). No other sites, no analytics.

## Publishing to the Chrome Web Store
1. Bump `version` in `manifest.json`.
2. `./pack.sh` → `dist/overleaf-ai-checker-<version>.zip` (excludes README, scripts, dot-files).
3. [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → New item → upload the zip.
4. Store listing: name "Overleaf AI Checker", category Productivity, 1280×800 screenshots of the highlighted PDF,
   the 128px icon from `icons/`. Description: see `STORE_LISTING.md`.
5. Privacy tab: single purpose = "Highlight AI-written text in the compiled PDF of an Overleaf project".
   Permission justifications are in `STORE_LISTING.md`. Declare that the extension sends document text to
   Pangram's API (user-provided key) and nothing else; link the privacy policy (`PRIVACY.md`, host it on a public URL).
6. Submit for review. Reviews typically take 1–3 business days; host-permission extensions get a closer look,
   so keep the justification text precise.

## Notes / limits
- The highlighted-PDF export draws rectangles in page space; rotated pages or unusual MediaBox origins may offset boxes.
- Word boxes are estimated proportionally within each text run (pdf.js does not expose per-glyph widths).
- Pangram scores segments (roughly paragraphs); all words in a segment share its score.
