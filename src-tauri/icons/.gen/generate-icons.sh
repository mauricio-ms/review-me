#!/usr/bin/env bash
set -euo pipefail

# generate-icons.sh — render the high-quality app icon set from review-me's own
# on-screen logo and downscale it to the sizes the app + launcher use.
#
# The brand mark is the pixel-art magnifying-glass badge drawn by
# src/components/StartupDashboard.tsx, not a static image, so logo-mark.html
# (next to this script) reproduces it at a fixed large size and headless
# Chromium rasterizes that. Re-run this after touching the startup logo — its
# markup, the .startup-logo-* CSS, or the theme tokens — so the window/taskbar
# icons (bundled by Tauri) and the launcher icon stay in sync.
#
# Requires: chromium (or chromium-browser/google-chrome) and ImageMagick.

GEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS_DIR="$(cd "$GEN_DIR/.." && pwd)"
MASTER="$GEN_DIR/master-2048.png"

CHROMIUM="$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable || true)"
MAGICK="$(command -v magick || command -v convert || true)"
[[ -n "$CHROMIUM" ]] || { echo "chromium not found" >&2; exit 1; }
[[ -n "$MAGICK"   ]] || { echo "ImageMagick (magick/convert) not found" >&2; exit 1; }
[[ -f "$GEN_DIR/logo-mark.html" ]] || { echo "missing $GEN_DIR/logo-mark.html" >&2; exit 1; }

# 1024 stage at device-scale-factor 2 -> a 2048px master with a transparent
# surround. Chromium may print harmless dbus/GPU noise; the output is what counts.
echo "==> Rendering logo-mark.html -> $MASTER"
"$CHROMIUM" --headless --no-sandbox --hide-scrollbars \
  --default-background-color=00000000 \
  --force-device-scale-factor=2 \
  --window-size=1024,1024 \
  --virtual-time-budget=3000 \
  --screenshot="$MASTER" \
  "file://$GEN_DIR/logo-mark.html" >/dev/null 2>&1
[[ -s "$MASTER" ]] || { echo "chromium produced no screenshot" >&2; exit 1; }

# PNG32: forces 32-bit RGBA output. Without it ImageMagick "helpfully" writes
# grayscale+alpha for an achromatic mark, and tauri::generate_context! then
# fails the build with "icon <path> is not RGBA".
resize() { "$MAGICK" "$MASTER" -filter Lanczos -resize "${1}x${1}" -strip PNG32:"$2"; }

echo "==> Writing icon set"
resize 32  "$ICONS_DIR/32x32.png"        # Tauri bundle (window/taskbar)
resize 128 "$ICONS_DIR/128x128.png"      # Tauri bundle
resize 256 "$ICONS_DIR/128x128@2x.png"   # Tauri bundle (hidpi)
resize 512 "$ICONS_DIR/icon-512.png"     # launcher master

# Guard the above: a non-RGBA icon only surfaces as a build failure much later.
for png in 32x32.png 128x128.png 128x128@2x.png icon-512.png; do
  ch="$("$MAGICK" identify -format '%[channels]' "$ICONS_DIR/$png")"
  [[ "$ch" == srgba* ]] || { echo "$png is $ch, expected srgba (RGBA)" >&2; exit 1; }
done

rm -f "$MASTER"
echo "Done."
