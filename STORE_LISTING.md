# Chrome Web Store listing

**Name:** Overleaf AI Checker
**Summary (132 chars max):** Recompile, pick a page range, and download your Overleaf PDF with AI-written text color-coded by Pangram (green = human, red = AI).

**Description:**
Overleaf AI Checker adds an "AI check" button to Overleaf's PDF toolbar. Click it, optionally recompile, choose
a page range, and download a copy of your compiled PDF in which every word on those pages is color-coded by
Pangram's AI detector: green = human-written, yellow = AI-assisted, red = AI-generated. Pages outside the range are
left untouched, and a one-line summary (percent AI / AI-assisted / human) is stamped on the first selected page.

Nothing is drawn on the Overleaf page itself. Requires a Pangram API key (pangram.com), which you enter once in the
extension popup and can change at any time. The key is stored locally in Chrome's extension storage. The text of the
selected pages is sent only to Pangram; nothing is sent anywhere else and no analytics are collected.

**Category:** Productivity · **Language:** English

## Permission justifications (Privacy practices tab)
- `storage`: saves the user's Pangram API key and the "auto re-check" preference.
- `offscreen`: runs pdf.js in a worker to extract text from the compiled PDF and pdf-lib to export the highlighted PDF.
- Host `https://www.overleaf.com/*`: inject the toolbar button and overlays on project pages; fetch the user's own compiled PDF.
- Host `https://text.external-api.pangram.com/*`: send PDF text for AI-likelihood scoring with the user's key.
- Remote code: none. All scripts are bundled (pdf.js, pdf-lib).

**Single purpose:** Download a copy of an Overleaf project's compiled PDF with AI-written text highlighted (Pangram).
**Data usage:** Website content (PDF text) is transmitted to Pangram for the extension's core function; not sold,
not used for unrelated purposes, not for creditworthiness.

**Privacy policy URL:** https://github.com/iamjanvijay/overleaf-ai-checker/blob/main/PRIVACY.md
**Homepage URL:** https://github.com/iamjanvijay/overleaf-ai-checker
