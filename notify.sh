#!/usr/bin/env bash
# Claude Code Notification Hook
# Handles: Stop, PermissionRequest, PreToolUse(AskUserQuestion)
# Sends: macOS desktop notification + OSC 9 terminal notification + tmux bell

set -euo pipefail

input=$(cat)
hook_event=$(jq -r '.hook_event_name // empty' <<<"$input")

# Determine title and body based on hook event
case "$hook_event" in
  "Stop")
    title="Claude Code"
    body="Ready for review"
    ;;
  "PermissionRequest")
    tool_name=$(jq -r '.tool_name // "unknown"' <<<"$input")
    title="Claude Code"
    body="Waiting for you - Needs permission ($tool_name)"
    ;;
  "PreToolUse")
    tool_name=$(jq -r '.tool_name // empty' <<<"$input")
    # Only notify for AskUserQuestion tool
    if [[ "$tool_name" != "AskUserQuestion" ]]; then
      exit 0
    fi
    title="Claude Code"
    body="Question for you - OpenCode needs your input"
    ;;
  "Notification")
    # Legacy support for Notification hook
    title=$(jq -r '.notification_type // "Claude Code"' <<<"$input")
    body=$(jq -r '.message // "Needs your attention"' <<<"$input")
    ;;
  *)
    # Unknown event, silently exit
    exit 0
    ;;
esac

# macOS desktop notification (side effect)
osascript -e "display notification \"$body\" with title \"$title\" sound name \"default\"" >/dev/null 2>&1 || true

# Build OSC 9 terminal notification sequence
if [ -n "${TMUX:-}" ]; then
  # tmux passthrough: DCS tmux; <seq> ST + BEL for tmux bell
  seq=$(printf '\033Ptmux;\033\033]9;%s\007\033\\\007' "$body")
else
  # standard OSC 9: ESC ] 9 ; message BEL
  seq=$(printf '\033]9;%s\007' "$body")
fi

# Return JSON with terminalSequence for Claude Code to emit
jq -nc --arg seq "$seq" '{terminalSequence: $seq}'
