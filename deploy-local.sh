#!/usr/bin/env bash
# Publish this fork as the locally running herdr-web-ui, and keep the app's
# updater pointed at this fork's GitHub release.
#
# One command does: build, upload the bundle to the fork's GitHub release,
# write the manifest that makes the app download updates from that release,
# copy the fresh code into the installed bundle, and restart the bridge
# (herdr respawns it). Re-run after any change; also re-run if an official
# herdr update replaces the installed bundle directory.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
GITHUB_REPO="dejay2/herdr-web-ui"
BUNDLE_DIR="$(ls -d "$HOME/.local/share/herdr-web-ui"/remote-v*-e* 2>/dev/null | sort | tail -1)"
BUN="$HOME/.local/share/herdr-web-ui/$(basename "$BUNDLE_DIR")/bin/bun"
[ -x "$BUN" ] || BUN="$(command -v bun)"
# the build scripts call `bun` by name for their own steps
export PATH="$(dirname "$BUN"):$PATH"
PLATFORM="${1:-linux-x64}"

echo "repo:   $REPO"
echo "bundle: $BUNDLE_DIR"
echo "platform: $PLATFORM"

cd "$REPO"
"$BUN" install
"$BUN" run build
"$BUN" run build:remote "$PLATFORM"

# --- the GitHub release: the update source the app fetches from ---
MANIFEST="remote-bundles/manifest-$PLATFORM.json"
TGZ="remote-bundles/herdr-web-ui-$PLATFORM.tgz"
VERSION="$(python3 -c "import json; print(json.load(open('$MANIFEST'))['version'])")"
TAG="remote-v$VERSION"
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" \
  --title "herdr-web-ui $TAG ($GITHUB_REPO)" \
  --notes "Self-hosted update source for the $GITHUB_REPO fork."
gh release upload "$TAG" "$TGZ" --clobber

# the running app reads its manifest from <bundle>/remote-bundles/; a
# GitHub-flavoured copy of the manifest points the downloader at the release
python3 - "$MANIFEST" "$PLATFORM" "$GITHUB_REPO" "$VERSION" <<'PY'
import json, sys
manifest_path, platform, repo, version = sys.argv[1:5]
m = json.load(open(manifest_path))
asset = m["assets"][platform]
asset["url"] = f"https://github.com/{repo}/releases/download/remote-v{version}/herdr-web-ui-{platform}.tgz"
out = manifest_path.replace(".json", "-github.json")
json.dump(m, open(out, "w"), indent=2)
print(open(out).read())
PY

# --- install into the running app ---
mkdir -p "$BUNDLE_DIR/remote-bundles"
cp "remote-bundles/manifest-$PLATFORM-github.json" "$BUNDLE_DIR/remote-bundles/manifest-$PLATFORM.json"
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
