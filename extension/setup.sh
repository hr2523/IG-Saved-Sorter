#!/usr/bin/env bash
# Vendor transformers.js + the onnxruntime WASM binaries INTO the extension so
# nothing is loaded from a CDN at runtime (Manifest V3 forbids remote code).
# Run once after cloning. Requires Node.js + npm.
#
#   bash extension/setup.sh
#
# Produces:
#   extension/src/lib/transformers.min.js   (bundled ESM, named exports)
#   extension/src/wasm/*.wasm               (onnxruntime-web backends)
set -euo pipefail

cd "$(dirname "$0")"

VERSION="2.17.2"   # @xenova/transformers, pinned

command -v npm >/dev/null 2>&1 || { echo "npm (Node.js) is required. Install Node from https://nodejs.org"; exit 1; }

echo "Installing @xenova/transformers@$VERSION + esbuild (temporary build deps)…"
npm install --no-save "@xenova/transformers@$VERSION" esbuild >/dev/null 2>&1

mkdir -p src/lib src/wasm

echo "Bundling transformers.js into a single local ESM file…"
printf "export * from '@xenova/transformers';\n" > .igss-entry.mjs
npx --yes esbuild .igss-entry.mjs \
  --bundle --format=esm --platform=browser \
  --outfile=src/lib/transformers.min.js
rm -f .igss-entry.mjs

echo "Copying onnxruntime WASM binaries locally…"
copied=0
for dir in node_modules/onnxruntime-web/dist node_modules/@xenova/transformers/dist; do
  if [ -d "$dir" ]; then
    if ls "$dir"/*.wasm >/dev/null 2>&1; then
      cp "$dir"/*.wasm src/wasm/ && copied=1
    fi
  fi
done
[ "$copied" = "1" ] || { echo "WARNING: no .wasm files found to copy — check node_modules/onnxruntime-web/dist"; }

echo ""
echo "Done. Vendored:"
echo "  - src/lib/transformers.min.js"
echo "  - src/wasm/$(ls src/wasm 2>/dev/null | tr '\n' ' ')"
echo ""
echo "Next: load the 'extension/' folder via chrome://extensions (Developer mode -> Load unpacked)."
