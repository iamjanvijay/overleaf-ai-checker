#!/bin/bash
# Builds a Chrome Web Store upload zip in dist/
set -euo pipefail
cd "$(dirname "$0")"
V=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist; OUT="dist/overleaf-ai-checker-$V.zip"; rm -f "$OUT"
zip -qr "$OUT" manifest.json background.js content.js content.css offscreen.html offscreen.js popup.html popup.js pdf.min.js pdf.worker.min.js pdf-lib.min.js icons -x '*.DS_Store'
echo "✓ $OUT ($(du -h "$OUT" | cut -f1))"
