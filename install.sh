#!/usr/bin/env bash
set -euo pipefail

# install.sh — build review-me and register it with the XDG app launcher
# (Walker on Omarchy, GNOME/KDE search, etc.) in one step.
#
#   ./install.sh             build + install the launcher entry
#   ./install.sh --restart   also (re)start the app afterwards

# ── CONFIG ───────────────────────────────────────────────────────────────────
APP_NAME="review-me"           # human-readable launcher name shown in the menu
BIN_NAME="review-me"           # binary + identifier: StartupWMClass, Icon, files
GENERIC_NAME="Code Review Tool"
COMMENT="Magit-style code-review tool for LLM-agent diffs"
CATEGORIES="Development;RevisionControl;"  # XDG categories, semicolon-terminated
KEYWORDS="git;diff;review;code;vim;magit;" # launcher search keywords
# Path to the built release binary, relative to the repo root. productName and
# the Cargo package name are both "review-me", with no [[bin]] override.
RELEASE_BIN="src-tauri/target/release/$BIN_NAME"
# Icon sizes installed into the hicolor theme — "WxH:source-file-in-$ICONS_SRC".
ICON_SIZES=(
  "32x32:32x32.png"
  "128x128:128x128.png"
  "256x256:128x128@2x.png"
  "512x512:icon-512.png"
)
# ─────────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$ROOT/bin"
BIN="$BIN_DIR/$BIN_NAME"
ICONS_SRC="$ROOT/src-tauri/icons"          # where the source PNGs live

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
HICOLOR="$DATA_HOME/icons/hicolor"
DESKTOP="$APPS_DIR/$BIN_NAME.desktop"

cd "$ROOT"

# 1. Dependencies. review-me spawns no sidecar or helper process, so the
#    frontend deps are all a clean checkout needs in order to build.
echo "==> Installing dependencies"
npm ci

# 2. Build the release binary and install it into bin/ (bin/ is gitignored).
#    --no-bundle: we only want the executable, not the deb/AppImage bundles.
echo "==> Building release binary (this is slow)"
npm run tauri build -- --no-bundle
install -d "$BIN_DIR"
install -m 0755 "$RELEASE_BIN" "$BIN"
echo "    Installed $BIN"

# 3. App icon — install every size into the hicolor theme so the launcher can
#    pick the crispest one; referenced by name (Icon=$BIN_NAME). Re-render the
#    set from the startup-dashboard logo first when Chromium is available, so an
#    edited logo never ships stale PNGs.
echo "==> Installing app icon"
if [[ -x "$ICONS_SRC/.gen/generate-icons.sh" ]] && {
     command -v chromium >/dev/null 2>&1 ||
     command -v chromium-browser >/dev/null 2>&1 ||
     command -v google-chrome-stable >/dev/null 2>&1
   }; then
  "$ICONS_SRC/.gen/generate-icons.sh"
fi
for pair in "${ICON_SIZES[@]}"; do
  size="${pair%%:*}"
  src="$ICONS_SRC/${pair#*:}"
  dst_dir="$HICOLOR/$size/apps"
  install -d "$dst_dir"
  install -m 0644 "$src" "$dst_dir/$BIN_NAME.png"
done
gtk-update-icon-cache -f -t "$HICOLOR" 2>/dev/null || true

# 4. Desktop entry. Path= sets the working directory to the repo root: review-me
#    has no cwd-relative resources, but it keeps the file browser's fallback
#    (fs_browse::browse_dir, used only when $HOME is unset) somewhere sane, and
#    it lets Exec stay a plain quoted path — the Desktop Entry spec forbids the
#    reserved chars a `sh -c 'cd … && …'` wrapper would need.
echo "==> Registering desktop launcher entry"
install -d "$APPS_DIR"
cat >"$DESKTOP" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=$APP_NAME
GenericName=$GENERIC_NAME
Comment=$COMMENT
Exec="$BIN"
Path=$ROOT
Icon=$BIN_NAME
Terminal=false
Categories=$CATEGORIES
Keywords=$KEYWORDS
StartupNotify=true
StartupWMClass=$BIN_NAME
EOF
chmod 0644 "$DESKTOP"
update-desktop-database "$APPS_DIR" 2>/dev/null || true
# Sanity-check the entry if the validator is available.
command -v desktop-file-validate >/dev/null && desktop-file-validate "$DESKTOP"
echo "    Installed $DESKTOP"

# 5. Optionally (re)start the running app.
if [[ "${1:-}" == "--restart" ]]; then
  echo "==> Restarting $BIN_NAME"
  pkill -x "$BIN_NAME" || true
  (cd "$ROOT" && "$BIN" >/dev/null 2>&1 &)
fi

echo
echo "Done. Search '$APP_NAME' in the app launcher (SUPER + SPACE on Omarchy)."
