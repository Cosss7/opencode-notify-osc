# opencode-notify-osc

Terminal notifications for AI coding assistants via [OSC 9](https://iterm2.com/documentation-escape-sequences.html) escape sequences.

Supports both **Claude Code hooks** and **OpenCode plugin**.

- **macOS desktop notification** via `osascript`
- **Terminal notification** via OSC 9 (Ghostty, iTerm2, WezTerm, Windows Terminal, etc.)
- **Audible bell** in tmux sessions

---

## Table of Contents

- [Claude Code Hooks](#claude-code-hooks)
- [OpenCode Plugin](#opencode-plugin)
- [Requirements](#requirements)
- [License](#license)

---

## Claude Code Hooks

Use `notify.sh` as a [Claude Code hook](https://code.claude.com/docs/en/hooks) to get notified when Claude needs your attention.

### Events

| Hook Event | When | Notification |
|-----------|------|-------------|
| `Stop` | Claude finishes responding | "Ready for review" |
| `PermissionRequest` | A tool needs permission | "Waiting for you - Needs permission ({tool})" |
| `PreToolUse` | Claude is about to use a tool | Only notifies for `AskUserQuestion`: "Question for you" |

### Installation

1. Clone this repository
2. Add to your Claude Code settings (`~/.claude/settings.json` or `.claude/settings.json` in your project):

```json
{
  "hooks": {
    "Stop": {
      "type": "script",
      "command": "/absolute/path/to/notify.sh"
    },
    "PermissionRequest": {
      "type": "script",
      "command": "/absolute/path/to/notify.sh"
    },
    "PreToolUse": {
      "type": "script",
      "command": "/absolute/path/to/notify.sh"
    }
  }
}
```

### How It Works

`notify.sh` reads the hook event JSON from stdin and outputs a `terminalSequence` field that Claude Code emits to your terminal:

```bash
# OSC 9 notification sequence
\x1b]9;Ready for review\x07
```

The script also triggers a native macOS notification via `osascript`.

---

## OpenCode Plugin

Use `opencode-notify-osc.ts` as an OpenCode plugin for terminal notifications.

### Events

| Event | When | Message |
|-------|------|---------|
| `session.idle` / `session.status` | Conversation ends | `{prefix}: Ready for review - {sessionTitle}` |
| `session.error` | Error occurs | `{prefix}: Something went wrong - {error}` |
| `permission.asked` | Permission request | `{prefix}: Waiting for you - OpenCode needs your input` |
| `tool.execute.before` (tool=question) | Question asked | `{prefix}: Question for you - OpenCode needs your input` |

### Installation

**Option 1: Local plugin**

```bash
# Global
cp opencode-notify-osc.ts ~/.config/opencode/plugins/

# Or project-level
cp opencode-notify-osc.ts .opencode/plugins/
```

Restart OpenCode.

**Option 2: opencode.json**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-notify-osc"]
}
```

### Configuration

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

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `notifyChildSessions` | `boolean` | `false` | Notify for child/sub-session events |
| `quietHours.enabled` | `boolean` | `false` | Suppress notifications during quiet hours |
| `quietHours.start` | `string` | `"22:00"` | Quiet hours start (HH:MM) |
| `quietHours.end` | `string` | `"08:00"` | Quiet hours end (HH:MM) |
| `titlePrefix` | `string` | `"OpenCode"` | Prefix for all messages |

#### Quiet Hours

Supports overnight ranges (e.g., `22:00` - `08:00`).

#### Child Sessions

By default, only parent sessions trigger notifications. Set `notifyChildSessions: true` to include sub-agents and background tasks.

### How It Works

The plugin writes OSC 9 sequences directly to `stderr`:

```
\x1b]9;OpenCode: Ready for review - Task\x07
```

Your terminal intercepts this and displays a native notification.

---

## Requirements

- **macOS** (for desktop notifications via `osascript`)
- **`jq`** for Claude Code hooks (`brew install jq`)
- **Terminal with OSC 9 support**: Ghostty, iTerm2, WezTerm, Windows Terminal, ConEmu, Kitty (via OSC 99), Warp (via OSC 777)

---

## License

MIT
