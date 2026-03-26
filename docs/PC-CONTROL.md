# PC Control

Let the AI see your screen, click buttons, type text, and run commands on your PC (or any remote PC). The system uses a 3-layer pipeline that automatically picks the fastest approach for each task.

---

## How It Works

```
"click the Save button"
        |
   Layer 1: Action Router        zero LLM — regex patterns for common actions
        |  (no match)
   Layer 2: Accessibility Tree   text-only LLM — queries OS UI element tree
        |  (not available)
   Layer 3: Vision               vision LLM — analyzes a screenshot
        |
   Execute on PC
```

1. **Action Router** — 30+ regex patterns handle copy, paste, scroll, keyboard shortcuts, window management. Instant execution, zero LLM calls, zero cost.
2. **Accessibility Tree** — Queries the OS for visible UI elements (buttons, text fields, menus) with bounding boxes. A lightweight text-only LLM maps intent to elements. No screenshot needed.
3. **Vision** — Captures a screenshot, sends it to a vision-capable LLM, and parses coordinates. Always available as a fallback.

Each layer falls through to the next if it can't handle the task. The AI never sees raw coordinates — it describes intent, the pipeline resolves the rest.

---

## Quick Start

### 1. Enable PC Control

PC control is disabled by default. Enable it in the UI:

1. Click the monitor icon in the sidebar
2. Toggle **PC Control** on

Or via the API:

```bash
curl -X PUT http://localhost:3001/api/pc/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

### 2. Use It

Once enabled, ask the AI naturally:

> "What's on my screen right now?"

> "Open Firefox and go to github.com"

> "Click the Submit button"

> "Press Ctrl+S to save"

> "Type hello@example.com in the email field"

The AI uses `native__pc_observe` to see the screen, then `native__pc_do` to act.

---

## Local vs Remote

### Local mode (automatic)

When the Chvor server runs on a machine with a display, PC control works automatically — the server imports the `@chvor/pc-agent` library directly with zero network hop.

Check if local mode is available:

```bash
curl http://localhost:3001/api/pc/config
# → { "enabled": true, "safetyLevel": "supervised", "localAvailable": true }
```

### Remote mode

Control any PC on your network by running the agent CLI on it:

```bash
npx @chvor/pc-agent --server ws://your-server:3001/ws/pc-agent --token <token>
```

The server prints the token on startup:

```
[pc-control] No CHVOR_TOKEN set — generated session token: abc-123-...
[pc-control] Use: npx @chvor/pc-agent --server ws://localhost:3001/ws/pc-agent --token abc-123-...
```

The agent auto-reconnects with exponential backoff if the connection drops.

#### CLI Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--server <url>` | — | `ws://localhost:3001/ws/pc-agent` | WebSocket URL of the Chvor server |
| `--token <token>` | `CHVOR_PC_AGENT_TOKEN` or `CHVOR_TOKEN` | — | Auth token |

---

## Safety Levels

| Level | Behavior |
|-------|----------|
| **Supervised** (default) | Every action requires your approval before executing |
| **Semi-autonomous** | Known-safe actions (keyboard shortcuts, scroll) auto-approved; everything else needs approval |
| **Autonomous** | AI acts freely — watch what it does via the PC viewer |

Shell commands **always** require approval regardless of safety level.

Change the safety level in the PC viewer sidebar or via API:

```bash
curl -X PUT http://localhost:3001/api/pc/config \
  -H 'Content-Type: application/json' \
  -d '{"safetyLevel": "semi-autonomous"}'
```

---

## AI Tools

The AI gets three tools when PC control is enabled:

| Tool | Description |
|------|-------------|
| `native__pc_do` | Describe a task in natural language. The pipeline resolves it. |
| `native__pc_observe` | See the screen + list of UI elements (accessibility tree). |
| `native__pc_shell` | Run a shell command on the target PC. |

### Typical workflow

1. AI calls `native__pc_observe` — gets a screenshot and the accessibility tree
2. AI calls `native__pc_do` with `"click the Save button"` — resolved via a11y tree (Layer 2)
3. AI calls `native__pc_observe` again — verifies the result
4. For file operations, AI uses `native__pc_shell` with `"ls -la"` — always prompts for approval

### Multiple PCs

When multiple PCs are connected, the AI can target a specific one:

```
native__pc_do({ task: "open Notepad", targetId: "abc-123" })
```

Omit `targetId` to use the local PC (or the first connected remote).

---

## PC Viewer

The PC viewer is an overlay accessible from the sidebar monitor icon. It shows:

- **Live screenshots** from the active PC (throttled to 1 frame/sec)
- **Connected PCs** with status indicators
- **Pipeline activity** — which layer is currently processing
- **Safety level selector**
- **Instructions** for connecting remote PCs

---

## Platform Support

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Screen capture | Yes | Yes | Yes |
| Input simulation | Yes | Yes | Yes |
| Accessibility tree | Yes (PowerShell/.NET) | Planned | Planned |
| Shell execution | Yes | Yes | Yes |

On macOS and Linux, the accessibility tree is not yet implemented. The pipeline gracefully falls through to vision (Layer 3) for any tasks that would use it.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/pc/config` | Get config (enabled, safetyLevel, localAvailable) |
| `PUT` | `/api/pc/config` | Update config (enabled, safetyLevel) |
| `GET` | `/api/pc/connections` | List connected PCs (including local) |
| `GET` | `/api/pc/connections/:id` | Get specific PC info |
| `DELETE` | `/api/pc/connections/:id` | Disconnect a remote PC |
| `POST` | `/api/pc/screenshot/:id` | Take a screenshot |

WebSocket endpoint for remote agents: `ws://host:port/ws/pc-agent?token=<token>`

---

## Architecture

```
routes/pc-control.ts         REST API for config + connections
lib/pc-control.ts            WebSocket agent registry, local/remote backends
lib/pc-backend.ts            PcBackend interface (local and remote implement this)
lib/pc-pipeline.ts           3-layer pipeline (action router → a11y → vision)
lib/action-patterns.ts       Layer 1 regex patterns
lib/native-tools.ts          AI tool handlers (pc_do, pc_observe, pc_shell)
packages/pc-agent/            Library + CLI agent
  src/lib/                   Screen capture, input simulation, shell
  src/lib/a11y/              Accessibility tree (win32, darwin, linux)
  src/cli.ts                 Standalone WebSocket agent
```
