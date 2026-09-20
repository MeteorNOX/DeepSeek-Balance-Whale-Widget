#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-assets/DSniang1.png}"
OUTPUT="${2:-build/AI Balance Whale.icns}"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "make-mac-icon.sh must run on macOS" >&2
  exit 2
fi
mkdir -p "$(dirname "$OUTPUT")"
ICONSET="$(mktemp -d "${TMPDIR:-/tmp}/ai-whale-icon.XXXXXX.iconset")"
trap 'rm -rf "$ICONSET"' EXIT
for spec in \
  "16 icon_16x16.png" "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do
  read -r size name <<<"$spec"
  sips -s format png -z "$size" "$size" "$SOURCE" --out "$ICONSET/$name" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUTPUT"
