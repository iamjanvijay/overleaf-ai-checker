# Chrome Web Store listing

**Name:** Overleaf AI Checker
**Summary (132 chars max):** Color-codes your compiled Overleaf PDF by AI-likelihood (Pangram): green = human, red = AI. Download the highlighted PDF.

**Description:**
Overleaf AI Checker adds an "AI check" button to Overleaf's PDF toolbar. One click sends the text of your
currently compiled PDF to Pangram's AI-detection API (using your own Pangram API key) and paints every word
on a green-to-red scale: green = human-written, yellow = AI-assisted, red = AI-generated. Hover any word for the
label, confidence and score. Hide or show the highlights at any time, keep scores across recompiles, and download
a copy of the PDF with the highlights baked in.

Requires a Pangram API key (pangram.com). Your key is stored locally in Chrome's extension storage. The text of
your PDF is sent only to Pangram; nothing is sent anywhere else and no analytics are collected.

**Category:** Productivity · **Language:** English

## Permission justifications (Privacy practices tab)
- `storage`: saves the user's Pangram API key and the "auto re-check" preference.
- `offscreen`: runs pdf.js in a worker to extract text from the compiled PDF and pdf-lib to export the highlighted PDF.
- Host `https://www.overleaf.com/*`: inject the toolbar button and overlays on project pages; fetch the user's own compiled PDF.
- Host `https://text.external-api.pangram.com/*`: send PDF text for AI-likelihood scoring with the user's key.
- Remote code: none. All scripts are bundled (pdf.js, pdf-lib).

**Single purpose:** Highlight AI-written text in the compiled PDF of an Overleaf project.
**Data usage:** Website content (PDF text) is transmitted to Pangram for the extension's core function; not sold,
not used for unrelated purposes, not for creditworthiness.

**Privacy policy URL:** https://github.com/iamjanvijay/overleaf-ai-checker/blob/main/PRIVACY.md
**Homepage URL:** https://github.com/iamjanvijay/overleaf-ai-checker
