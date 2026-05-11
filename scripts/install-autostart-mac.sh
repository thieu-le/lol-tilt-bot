#!/usr/bin/env bash
# Install lol-tilt-bot as a macOS LaunchAgent so it starts automatically at login.
# Run once: npm run install-autostart
set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node 2>/dev/null || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH. Install Node.js >= 20 first."
  exit 1
fi

PLIST_LABEL="com.lol-tilt-bot"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$BOT_DIR/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$BOT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/lol-tilt-bot.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/lol-tilt-bot-error.log</string>
</dict>
</plist>
EOF

# Unload first in case it was already registered, to avoid "already loaded" errors.
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "lol-tilt-bot is now set to start automatically at login."
echo "  Node:    $NODE_BIN"
echo "  Bot:     $BOT_DIR/src/index.js"
echo "  Logs:    $LOG_DIR/lol-tilt-bot.log"
echo "  Errors:  $LOG_DIR/lol-tilt-bot-error.log"
echo ""
echo "  Stop now:    launchctl unload \"$PLIST_PATH\""
echo "  Start now:   launchctl load \"$PLIST_PATH\""
echo "  Uninstall:   npm run uninstall-autostart"
