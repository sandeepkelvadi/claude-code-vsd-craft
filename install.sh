#!/usr/bin/env bash
# Install / update the Claude Code Control plugin into VSD Craft (StreamDock).
set -euo pipefail

PLUGIN="com.sandeep.claudecode.sdPlugin"
SRC="$(cd "$(dirname "$0")" && pwd)/$PLUGIN"
DEST_DIR="$HOME/Library/Application Support/HotSpot/StreamDock/plugins"
DEST="$DEST_DIR/$PLUGIN"

echo "▸ Source: $SRC"
echo "▸ Dest:   $DEST"

if [ ! -d "$SRC" ]; then echo "✗ plugin source not found"; exit 1; fi
if [ ! -d "$SRC/plugin/node_modules/ws" ]; then
  echo "▸ installing node deps (ws)…"
  ( cd "$SRC/plugin" && (command -v sfw >/dev/null 2>&1 && sfw npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) )
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
# copy everything except logs
rsync -a --exclude 'log' "$SRC/" "$DEST/"

echo "✓ Installed."
echo
echo "Next:"
echo "  1. Quit VSD Craft completely (menubar → Quit), then reopen it."
echo "  2. System Settings → Privacy & Security → Accessibility → enable 'VSD Craft'."
echo "     (also approve any Automation prompt the first time a button fires)"
echo "  3. In VSD Craft, find the 'Claude Code' category and drag actions onto keys/dials."
