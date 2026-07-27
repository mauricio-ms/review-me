#!/usr/bin/env bash
set -euo pipefail

# build-ubuntu.sh — produce an Ubuntu-installable package of review-me from a
# non-Ubuntu host, using Docker.
#
#   ./packaging/build-ubuntu.sh                  # .deb for Ubuntu 22.04+
#   ./packaging/build-ubuntu.sh --appimage       # .deb + AppImage
#   ./packaging/build-ubuntu.sh --ubuntu 24.04   # build against a newer base
#
# Artifacts land in dist-linux/. Copy one to the Ubuntu machine; nothing in this
# repo (node_modules, src-tauri/target) is touched — the container builds its own.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist-linux"
IMAGE_BASE="review-me-ubuntu-builder"

UBUNTU_VERSION="22.04"
BUNDLES="deb"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --appimage) BUNDLES="deb,appimage"; shift ;;
    --ubuntu)   UBUNTU_VERSION="${2:?--ubuntu needs a version, e.g. 24.04}"; shift 2 ;;
    -h|--help)  sed -n '3,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

IMAGE="$IMAGE_BASE:$UBUNTU_VERSION"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "the docker daemon is not reachable" >&2; exit 1; }

cd "$ROOT"

echo "==> Building the Ubuntu $UBUNTU_VERSION builder image"
docker build \
  --build-arg "UBUNTU_VERSION=$UBUNTU_VERSION" \
  -f packaging/Dockerfile \
  -t "$IMAGE" \
  .

echo "==> Building review-me ($BUNDLES)"
CONTAINER="$(docker create "$IMAGE" --bundles "$BUNDLES")"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
docker start -a "$CONTAINER"

echo "==> Collecting artifacts into dist-linux/"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$STAGE"' EXIT
BUNDLE_DIR="/src/src-tauri/target/release/bundle"
for kind in deb appimage; do
  [[ "$BUNDLES" == *"$kind"* ]] || continue
  if ! docker cp "$CONTAINER:$BUNDLE_DIR/$kind/." "$STAGE/" 2>/dev/null; then
    echo "    warning: no $kind artifacts produced" >&2
  fi
done
# Each bundler leaves its staging tree next to the package; keep only the
# package itself, plus the raw executable for anyone who'd rather not install.
find "$STAGE" -type f \( -name '*.deb' -o -name '*.AppImage' \) \
  -exec install -m 0644 -t "$OUT_DIR" {} +
docker cp "$CONTAINER:/src/src-tauri/target/release/review-me" "$OUT_DIR/review-me" 2>/dev/null || true
chmod +x "$OUT_DIR"/*.AppImage 2>/dev/null || true

echo
echo "Artifacts:"
ls -lh "$OUT_DIR"
cat <<EOF

On the Ubuntu machine:
  sudo apt install ./$(cd "$OUT_DIR" && ls *.deb 2>/dev/null | head -1)
EOF
