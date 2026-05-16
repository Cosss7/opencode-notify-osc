# opencode-notify-osc

OpenCode plugin that sends OSC 9 notification sequences to your terminal.

Replicates the event/hook listening logic from [opencode-notify](https://github.com/kdcokenny/opencode-notify), but uses OSC 9 terminal notifications instead of desktop notifications.

## What it does

When OpenCode needs your attention, this plugin sends an [OSC 9](https://iterm2.com/documentation-escape-sequences.html) escape sequence to your terminal, which triggers a native notification in supported terminals.

**Supported terminals:** Ghostty, iTerm2, WezTerm, Windows Terminal, and any terminal that supports OSC 9 notifications.

## Triggers

| Event | When | OSC Message |
|-------|------|-------------|
| `session.idle` / `session.status` | LLM conversation ends | `{prefix}: Ready for review - {sessionTitle}` |
| `session.error` | Error occurs | `{prefix}: Something went wrong - {error}` |
| `permission.asked` / `permission.updated` | Permission request | `{prefix}: Waiting for you - OpenCode needs your input` |
| `tool.execute.before` (tool=question) | OpenCode asks a question | `{prefix}: Question for you - OpenCode needs your input` |
| `question.asked` | Direct question event | `{prefix}: Question for you - OpenCode needs your input` |

## Installation

### Option 1: Local plugin

Copy `opencode-notify-osc.ts` to your OpenCode plugins directory:

```bash
# Global
cp opencode-notify-osc.ts ~/.config/opencode/plugins/

# Or project-level
cp opencode-notify-osc.ts .opencode/plugins/
```

Restart OpenCode. The plugin will be loaded automatically.

### Option 2: opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-notify-osc"]
}
```

## Configuration

Create `~/.config/opencode/opencode-notify-osc.json`:

```json
{
  "notifyChildSessions": false,
  "quietHours": {
    "enabled": false,
    "start": "22:00",
    "end": "08:00"
  },
  "titlePrefix": "OpenCode"
}
```

### Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `notifyChildSessions` | `boolean` | `false` | When `true`, also notify for child/sub-session events |
| `quietHours.enabled` | `boolean` | `false` | Enable quiet hours suppression |
| `quietHours.start` | `string` | `"22:00"` | Quiet hours start time (HH:MM) |
| `quietHours.end` | `string` | `"08:00"` | Quiet hours end time (HH:MM) |
| `titlePrefix` | `string` | `"OpenCode"` | Prefix for all notification messages |

### Quiet Hours

When quiet hours are enabled, notifications are suppressed during the specified time window. Supports overnight ranges (e.g., `22:00` - `08:00`).

### Child Sessions

By default, only parent sessions trigger notifications. Sub-agents and background tasks won't spam you. Set `notifyChildSessions: true` to include them.

## How it works

The plugin hooks into OpenCode's event system and writes OSC 9 sequences to `stderr`:

```
\x1b]9;OpenCode: Ready for review - Task\x07
```

Your terminal intercepts this sequence and displays a native notification.

## License

MIT
