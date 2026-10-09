# Overleaf AI Checker (Chrome extension)

Repository: https://github.com/iamjanvijay/overleaf-ai-checker · Privacy policy: https://github.com/iamjanvijay/overleaf-ai-checker/blob/main/PRIVACY.md

Adds a **🤖 AI check** button to Overleaf's PDF toolbar. It does one thing:

1. (Optionally) recompiles the project and waits for the fresh PDF.
2. You choose a page range (e.g. 1 to 10).
3. The text of those pages is scored with [Pangram](https://www.pangram.com) using your own API key.
4. A copy of the PDF is downloaded with every word on those pages color-coded on a green (human) → yellow
   (AI-assisted) → red (AI) scale. Pages outside the range are left untouched. A one-line summary is stamped
   at the top of the first selected page.

Nothing is drawn on the Overleaf page itself, so the editor stays fast and unchanged.

## Install (unpacked, for development)
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose this folder.
2. Click the extension icon → paste your Pangram API key → Save (you can change it any time).
3. Open an Overleaf project → click **🤖 AI check** in the PDF toolbar → set the pages → **Download highlighted PDF**.

## Architecture (Manifest V3)
| File | Role |
|---|---|
| `content.js` / `content.css` | Toolbar button and the small panel (recompile toggle, page range, download). Clicks Overleaf's Recompile and waits for the new PDF URL. |
| `background.js` | Service worker. Calls Pangram (`/task` + polling), chunks long inputs, caches results, computes the word boxes for the selected pages. |
| `offscreen.html` / `offscreen.js` | Offscreen document: fetches the compiled PDF with the user's Overleaf session, extracts positioned text with pdf.js, and writes the highlighted copy with pdf-lib. |
| `popup.html` / `popup.js` | API key entry. |
| `pdf.min.js`, `pdf.worker.min.js` | pdf.js 3.11.174 (Apache-2.0). |
| `pdf-lib.min.js` | pdf-lib 1.17.1 (MIT). |

Permissions: `storage` (API key), `offscreen` (pdf.js worker), host access to `www.overleaf.com` (read the compiled
PDF) and `text.external-api.pangram.com` (scoring). No other sites, no analytics, no remote code.

## Publishing to the Chrome Web Store
1. Bump `version` in `manifest.json`.
2. `./pack.sh` → `dist/overleaf-ai-checker-<version>.zip`.
3. Developer Dashboard → the item → Package → upload the zip → Submit for review.
   Listing text and justifications: `STORE_LISTING.md`. Images: `store-assets/`.

## Notes / limits
- Word boxes are estimated proportionally within each text run (pdf.js does not expose per-glyph widths).
- Pangram scores segments (roughly paragraphs); all words in a segment share its color.
- Rotated pages or unusual MediaBox origins may offset boxes.
