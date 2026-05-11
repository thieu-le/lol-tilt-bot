#!/usr/bin/env bash
# Remove the lol-tilt-bot LaunchAgent.
# Run: npm run uninstall-autostart
set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.lol-tilt-bot.plist"

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "Autostart not installed (plist not found at $PLIST_PATH)."
  exit 0
fi

launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "lol-tilt-bot autostart removed. The bot will no longer start at login."
