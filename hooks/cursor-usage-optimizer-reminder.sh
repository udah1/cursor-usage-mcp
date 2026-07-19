#!/bin/bash
# postToolUse hook for cursor-usage-optimizer.
#
# Injects the latest cached, FLAG-AWARE self-check reminder (only mentions modes
# that are actually active — conserve / follow-up / verbose) and refreshes it in
# the background (non-blocking). Works from a local clone (CURSOR_USAGE_MCP_DIR/dist)
# or from the npx-installed package. Fails open — never blocks a tool call.
set -u
cat >/dev/null 2>&1 || true

THROTTLE_SECONDS=120
STATE_FILE="$HOME/.cursor/hooks/.cursor-usage-optimizer-reminder.last"
REMINDER_CACHE="$HOME/.cursor/hooks/.cursor-usage-optimizer-reminder.txt"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/homebrew/bin/node" ]; then
  NODE_BIN="$HOME/homebrew/bin/node"
fi

now=$(date +%s)
last=0
if [ -f "$STATE_FILE" ]; then last=$(cat "$STATE_FILE" 2>/dev/null || echo 0); fi
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ $(( now - last )) -lt "$THROTTLE_SECONDS" ]; then echo '{}'; exit 0; fi
echo "$now" > "$STATE_FILE" 2>/dev/null || true

# Inject the cached reminder (empty/missing -> inject nothing).
if [ -n "$NODE_BIN" ]; then
  "$NODE_BIN" -e '
    const fs = require("fs");
    let msg = "";
    try { msg = fs.readFileSync(process.argv[1], "utf8").trim(); } catch {}
    process.stdout.write(msg ? JSON.stringify({ additional_context: msg }) : "{}");
  ' "$REMINDER_CACHE" 2>/dev/null || echo '{}'
else
  echo '{}'
fi

# Choose the refresh command: local checkout if available, else the npx bin.
if [ -n "${CURSOR_USAGE_MCP_DIR:-}" ] && [ -f "${CURSOR_USAGE_MCP_DIR}/dist/reminder-cli.js" ] && [ -n "$NODE_BIN" ]; then
  REFRESH="\"$NODE_BIN\" \"${CURSOR_USAGE_MCP_DIR}/dist/reminder-cli.js\""
else
  REFRESH="npx -y -p cursor-usage-optimizer cursor-usage-optimizer-reminder"
fi

# Detached background refresh for next time (adds no latency to the agent).
nohup sh -c "$REFRESH > \"$REMINDER_CACHE.tmp\" 2>/dev/null && mv \"$REMINDER_CACHE.tmp\" \"$REMINDER_CACHE\"" >/dev/null 2>&1 &

exit 0
