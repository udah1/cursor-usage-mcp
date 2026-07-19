#!/bin/bash
# postToolUse hook for the cursor-usage MCP.
#
# On each tool use (throttled), it:
#   1. Injects the latest cached, FLAG-AWARE self-check reminder produced by
#      reminder-cli. The reminder only mentions modes that are actually active
#      (conserve / follow-up / verbose), so once the quota is exhausted or a mode
#      is off, its instructions are NOT injected.
#   2. Kicks off a BACKGROUND refresh of that cached reminder (non-blocking), so
#      the next injection reflects the current state.
#
# It never blocks a tool call (fails open) and the refresh runs detached, so it
# adds no latency to the agent.

set -u

# Drain stdin (hook input JSON); we don't need it.
cat >/dev/null 2>&1 || true

THROTTLE_SECONDS=120
STATE_FILE="$HOME/.cursor/hooks/.cursor-usage-reminder.last"
REMINDER_CACHE="$HOME/.cursor/hooks/.cursor-usage-reminder.txt"

MCP_DIR="${CURSOR_USAGE_MCP_DIR:-$HOME/personal-dev/cursor-usage-mcp}"
CLI="$MCP_DIR/dist/reminder-cli.js"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/homebrew/bin/node" ]; then
  NODE_BIN="$HOME/homebrew/bin/node"
fi

now=$(date +%s)
last=0
if [ -f "$STATE_FILE" ]; then
  last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi
case "$last" in ''|*[!0-9]*) last=0 ;; esac

# Within the throttle window -> inject nothing.
if [ $(( now - last )) -lt "$THROTTLE_SECONDS" ]; then
  echo '{}'
  exit 0
fi
echo "$now" > "$STATE_FILE" 2>/dev/null || true

# Inject the cached reminder (node handles JSON escaping safely). If the cache is
# empty/missing (nothing active, or not warmed yet) inject nothing.
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

# Kick off a detached background refresh of the cached reminder for next time.
if [ -n "$NODE_BIN" ] && [ -f "$CLI" ]; then
  nohup sh -c "\"$NODE_BIN\" \"$CLI\" > \"$REMINDER_CACHE.tmp\" 2>/dev/null && mv \"$REMINDER_CACHE.tmp\" \"$REMINDER_CACHE\"" >/dev/null 2>&1 &
fi

exit 0
