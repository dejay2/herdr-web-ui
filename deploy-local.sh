#!/usr/bin/env bash
# Publish this fork as the locally running herdr-web-ui.
#
# Builds the repo, drops the result into the installed bundle directory
# (which herdr's bridge runs), and restarts the bridge. The official
# `herdr update` replaces the bundle directory, so re-run this after it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
# the installed bundle: remote-vNN-<hash>, with a remote-vNN symlink beside it
BUNDLE_DIR="$(ls -d "$HOME/.local/share/herdr-web-ui"/remote-v*-e* 2>/dev/null | sort | tail -1)"
BUN="$HOME/.local/share/herdr-web-ui/$(basename "$BUNDLE_DIR")/bin/bun"
[ -x "$BUN" ] || BUN="$(command -v bun)"

echo "repo:   $REPO"
echo "bundle: $BUNDLE_DIR"
echo "bun:    $BUN"

cd "$REPO"
"$BUN" install
"$BUN" run build

# code, not the runtime: bin/ and bundle.json stay the official ones
rsync -a --delete "$REPO/dist/" "$BUNDLE_DIR/dist/"
rsync -a --delete "$REPO/server/" "$BUNDLE_DIR/server/"
rsync -a --delete "$REPO/shared/" "$BUNDLE_DIR/shared/"
rsync -a --delete "$REPO/node_modules/" "$BUNDLE_DIR/node_modules/"
cp "$REPO/package.json" "$BUNDLE_DIR/package.json"

# restart the bridge; herdr respawns it within seconds
PID="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$HOME/.config/herdr-web-ui/bridges/"*.json 2>/dev/null | head -1 || true)"
if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
  echo "restarting bridge (pid $PID)"
  kill "$PID"
  for _ in $(seq 1 30); do
    sleep 1
    NEW="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['pid'])" "$HOME/.config/herdr-web-ui/bridges/"*.json 2>/dev/null | head -1 || true)"
    if [ -n "${NEW:-}" ] && [ "$NEW" != "$PID" ] && kill -0 "$NEW" 2>/dev/null; then
      echo "bridge back up (pid $NEW)"
      exit 0
    fi
  done
  echo "bridge did not come back; check $HOME/.config/herdr-web-ui/bridges/herdr.log" >&2
  exit 1
fi
echo "no running bridge found; nothing to restart"
