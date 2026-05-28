#!/bin/sh
# Deploy hush-web static client using a timestamped release + current symlink.
#
# Usage:
#   ./scripts/deploy.sh --target <document-root>
#   ./scripts/deploy.sh --target <document-root> --keep 10
#   ./scripts/deploy.sh --target <document-root> --no-build
#
# Deploy contract:
#   <target>/releases/YYYYMMDDHHMMSS-<shortsha>/   <- built dist/ contents
#   <target>/current -> releases/YYYYMMDDHHMMSS-<shortsha>/  <- symlink
#
# Configure your web server to serve from <target>/current.
# The symlink swap uses ln -sfn, which replaces the symlink directly without
# following it into the pointed-to directory (the mv -f trap on Linux).
# Old releases beyond --keep are pruned after a successful deploy.
#
# ---- VITE BUILD ENV VARS --------------------------------------------------
# When the SPA is served from the same origin as the API, no VITE_* env vars
# are required. Vite builds with relative path defaults (/api, /ws, /livekit)
# which route correctly through any reverse proxy in front of hush-server.
#
# Set VITE_API_BASE_URL, VITE_WS_URL, and VITE_LIVEKIT_URL only when the SPA
# is served from a different origin than the API.
#
# /admin is NOT part of this deploy. The admin UI is embedded in hush-server
# and is served via the reverse proxy at /admin. Do not include dist-admin/
# or any admin-specific assets in the client deploy.
# ---------------------------------------------------------------------------
#
# Exit codes:
#   0  Success
#   1  Pre-flight failure or deploy failure

set -eu

LOG_PREFIX="[hush-web-deploy]"
KEEP=5
BUILD=1
TARGET=""

log() { printf '%s %s\n' "$LOG_PREFIX" "$1"; }
err() { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$1" >&2; }
die() { err "$1"; exit "${2:-1}"; }

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --target)   TARGET="$2"; shift 2 ;;
    --keep)     KEEP="$2";   shift 2 ;;
    --no-build) BUILD=0;     shift   ;;
    *) die "Unknown flag: $1. Usage: $0 --target <path> [--keep N] [--no-build]" ;;
  esac
done

[ -n "$TARGET" ] || die "--target <document-root> is required"

case "$KEEP" in
  *[!0-9]*|"") die "--keep must be a positive integer" ;;
esac
[ "$KEEP" -ge 1 ] || die "--keep must be at least 1"

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Resolve TARGET to absolute path (create if missing)
mkdir -p "$TARGET/releases"
TARGET_ABS="$(cd "$TARGET" && pwd)"

# ---------------------------------------------------------------------------
# Release identifier: YYYYMMDDHHMMSS-<shortsha>
# ---------------------------------------------------------------------------
RELEASE="$(date +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
RELEASE_DIR="$TARGET_ABS/releases/$RELEASE"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if [ "$BUILD" -eq 1 ]; then
  log "Building (no VITE_* vars, using relative-path defaults)..."
  npm ci --silent
  npm run build
  log "Build complete."
fi

[ -d dist ] || die "dist/ not found. Run npm run build or pass --no-build after a prior build."

# ---------------------------------------------------------------------------
# Deploy to release directory
# ---------------------------------------------------------------------------
log "Creating release: $RELEASE"
mkdir -p "$RELEASE_DIR"
cp -r dist/. "$RELEASE_DIR/"

# ---------------------------------------------------------------------------
# Symlink swap: ln -sfn replaces the symlink in-place.
# Do NOT use: ln -s current.new + mv -f current.new current
# mv follows a symlink-to-directory and deposits current.new inside the old
# release dir instead of replacing the symlink (false-success deploy).
# ---------------------------------------------------------------------------
ln -sfn "releases/$RELEASE" "$TARGET_ABS/current"
log "Deployed: $TARGET_ABS/current -> releases/$RELEASE"

# ---------------------------------------------------------------------------
# Prune old releases
# ---------------------------------------------------------------------------
_index=0
for _r in $(ls -1 "$TARGET_ABS/releases" | sort -r); do
  _index=$((_index + 1))
  [ "$_index" -le "$KEEP" ] && continue
  rm -rf "${TARGET_ABS:?}/releases/$_r"
  log "Pruned: $_r"
done

log "Done. $KEEP most recent release(s) retained."
