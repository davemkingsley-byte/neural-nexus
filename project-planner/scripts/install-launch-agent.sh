#!/bin/bash
# Install (or remove) the ProjectDesk always-on server as a macOS LaunchAgent.
#
#   ./scripts/install-launch-agent.sh            install + start (port 4180)
#   ./scripts/install-launch-agent.sh --uninstall  stop + remove
#
# The agent starts at login and restarts on crash (KeepAlive). Logs go to
# /tmp/projectdesk-server.log. Check health: curl -s localhost:4180/api/ping
#
# IMPORTANT: after updating the code (git pull), restart the running server so
# it picks up the new modules:  launchctl kickstart -k gui/$(id -u)/com.projectdesk.server
# (a stale server normalizes away fields its old code doesn't know about)
set -euo pipefail

LABEL="com.projectdesk.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PROJECTDESK_PORT:-4180}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "ProjectDesk LaunchAgent removed."
  exit 0
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/server.js</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/projectdesk-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/projectdesk-server.log</string>
</dict>
</plist>
EOF

# Reload cleanly if already installed.
launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

sleep 1
if curl -sf "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
  echo "ProjectDesk server running: http://localhost:$PORT/  (starts at every login)"
else
  echo "Agent installed but the server is not answering yet — check /tmp/projectdesk-server.log"
  exit 1
fi
