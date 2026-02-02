---
name: gas-bridge
description: "Bridge OpenClaw events to the Global Agents System (GAS) hooks"
homepage: https://github.com/your-org/gas
metadata:
  {
    "openclaw":
      {
        "emoji": "🌉",
        "events": ["command:new", "command:stop", "command:reset", "gateway:startup"],
        "requires": { "bins": ["bash", "jq"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# GAS Bridge Hook

Bridges OpenClaw internal events to the Global Agents System (GAS) universal hooks.

## What It Does

When OpenClaw fires lifecycle events:

1. **Formats event as GAS JSON** - Converts OpenClaw event context to the GAS universal format
2. **Calls GAS scripts** - Pipes JSON to `~/.agents/hooks/session-start.sh` or `session-stop.sh`
3. **Logs to GAS** - Events are tracked in `~/.agents/.dev/hooks/*.log`

## Event Mapping

| OpenClaw Event      | GAS Hook              |
| ------------------- | --------------------- |
| `command:new`       | `session-start.sh`    |
| `command:reset`     | `session-stop.sh` → `session-start.sh` |
| `command:stop`      | `session-stop.sh`     |
| `gateway:startup`   | `session-start.sh`    |

## GAS JSON Format

```json
{
  "tool_name": "OpenClaw",
  "session_id": "agent:main:main",
  "timestamp": "2026-01-31T12:00:00Z",
  "cwd": "/Users/you/clawd",
  "project_name": "clawd",
  "user": "you",
  "hook_event": "SessionStart",
  "metadata": {
    "model": "anthropic/claude-opus-4-5",
    "tokens": { "input": 0, "output": 0 },
    "cost_usd": 0,
    "duration_ms": 0
  }
}
```

## Requirements

- **bash**: Shell for executing GAS scripts
- **jq**: JSON parsing (used by GAS hooks)
- **GAS hooks**: `~/.agents/hooks/session-start.sh` and `session-stop.sh` must exist

## Configuration

Enable/disable via:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "gas-bridge": { "enabled": true }
      }
    }
  }
}
```
