#!/usr/bin/env bash
# Build the Chrome Web Store upload zip from extension/dist.
#
# The store generates its own signing key on first upload and assigns the item
# ID from it, so the pinned development `key` is stripped here. After the first
# upload, copy the store's public key back into extension/manifest.json and
# extension/store-identities.json (see docs/chrome-web-store.md).
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f extension/dist/manifest.json ]] || { echo "extension/dist missing; run scripts/build.sh first" >&2; exit 1; }
VERSION=$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' extension/dist/manifest.json | head -1)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R extension/dist/. "$STAGE/"
python3 - "$STAGE/manifest.json" <<'EOF'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest.pop("key", None)
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
EOF

mkdir -p dist
OUT="$PWD/dist/Interceptor-Extension-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr -X "$OUT" . -x '.DS_Store' '*/.DS_Store')

# Self-check: the uploaded manifest must not carry the development key.
if unzip -p "$OUT" manifest.json | grep -q '"key"'; then
  echo "store zip still contains manifest#key" >&2; exit 1
fi
echo "$OUT ($(du -h "$OUT" | cut -f1), $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
