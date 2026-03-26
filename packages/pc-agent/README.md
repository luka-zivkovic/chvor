# @chvor/pc-agent

PC control agent for Chvor. Provides screen capture, input simulation, OS accessibility tree queries, and a CLI for remote PC control via WebSocket.

## Architecture

The system uses a **3-layer pipeline** that automatically selects the fastest method for each task:

```
User intent ("click Save")
         |
    Layer 1: Action Router     -- regex patterns, zero LLM, instant
         |  (fallthrough)
    Layer 2: Accessibility Tree -- OS a11y query + text-only LLM
         |  (fallthrough)
    Layer 3: Vision             -- screenshot + vision LLM
         |
    Execute action on PC
```

**Layer 1 — Action Router:** 30+ regex patterns match common tasks (copy, paste, scroll, keyboard shortcuts) and execute them instantly with zero LLM calls.

**Layer 2 — Accessibility Tree:** Queries the OS accessibility API for visible UI elements (buttons, text fields, menus) with bounding boxes. A lightweight text-only LLM maps the user's intent to specific elements. Windows is fully implemented via PowerShell/.NET `System.Windows.Automation`. macOS and Linux stubs gracefully fall through to vision.

**Layer 3 — Vision:** Captures a screenshot, sends it to a vision-capable LLM, and parses coordinates from the response. Always available as a fallback.

## Modes

### Local mode

When the Chvor server runs on a machine with a display, the server imports `@chvor/pc-agent` as a library directly — zero network hop. The server auto-detects this on startup.

### Remote mode

Run the CLI agent on any target PC. It connects to the server over WebSocket and receives commands.

## CLI Usage

```bash
# Connect to a Chvor server
npx @chvor/pc-agent --server ws://your-server:3001/ws/pc-agent --token <token>

# Using environment variables
CHVOR_TOKEN=abc123 npx @chvor/pc-agent --server ws://your-server:3001/ws/pc-agent

# Default (localhost:3001)
npx @chvor/pc-agent
```

### CLI Options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--server <url>` | — | `ws://localhost:3001/ws/pc-agent` | WebSocket URL of the Chvor server |
| `--token <token>` | `CHVOR_PC_AGENT_TOKEN` or `CHVOR_TOKEN` | — | Auth token (printed by server on startup if not set) |

The agent auto-reconnects with exponential backoff (3s to 60s) if the connection drops.

## Server Setup

### 1. Enable PC Control

PC control is feature-flagged and disabled by default.

```bash
# Via API
curl -X PUT http://localhost:3001/api/pc/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'

# Check status
curl http://localhost:3001/api/pc/config
# → { "enabled": true, "safetyLevel": "supervised", "localAvailable": true }
```

Or toggle it in the UI via the monitor icon in the sidebar.

### 2. Connect a Remote PC

The server prints a connection token on startup:

```
[pc-control] No CHVOR_TOKEN set — generated session token: abc-123-...
[pc-control] Use: npx @chvor/pc-agent --server ws://localhost:3001/ws/pc-agent --token abc-123-...
```

Run that command on the target PC. Once connected, it appears in the PC viewer sidebar.

## Safety Levels

| Level | Behavior |
|-------|----------|
| **Supervised** (default) | Every action requires user approval |
| **Semi-autonomous** | Action Router matches (keyboard shortcuts, etc.) auto-approved; everything else needs approval |
| **Autonomous** | AI acts freely — monitor via the viewer |

Shell commands (`native__pc_shell`) **always** require approval regardless of safety level.

## AI Tools

The server exposes three tools to the AI:

| Tool | Description |
|------|-------------|
| `native__pc_do` | Describe a task in natural language. The pipeline resolves it automatically. |
| `native__pc_observe` | Returns a screenshot + the UI accessibility tree (list of visible elements). |
| `native__pc_shell` | Execute a shell command on the target PC. Always requires approval. |

### Typical workflow

1. AI calls `native__pc_observe` to see what's on screen
2. AI calls `native__pc_do` with "click the Submit button" — pipeline resolves via a11y or vision
3. AI calls `native__pc_observe` again to verify the result

## Library API

The package can be imported directly (used by local mode):

```typescript
import {
  captureScreen,
  getScreenSize,
  executeAction,
  executeShellCommand,
  queryA11yTree,
  serializeA11yTree,
  findNodeById,
  bboxToCoordinate,
} from "@chvor/pc-agent";

// Screenshot
const screenshot = await captureScreen({ format: "jpeg", quality: 80 });

// Input simulation
await executeAction({ action: "left_click", coordinate: [500, 300] });
await executeAction({ action: "key", keys: "ctrl+s" });
await executeAction({ action: "type", text: "hello" });

// Accessibility tree
const tree = await queryA11yTree({ maxDepth: 6 });
if (tree) {
  const text = serializeA11yTree(tree, { maxDepth: 6, maxNodes: 200 });
  const node = findNodeById(tree, 42);
  if (node?.bbox) {
    const [x, y] = bboxToCoordinate(node.bbox, 1920, 1080);
  }
}

// Shell
const { stdout, stderr, exitCode } = await executeShellCommand("ls -la");
```

## Platform Support

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Screen capture | Yes | Yes | Yes |
| Input simulation | Yes | Yes | Yes |
| Accessibility tree | Yes (PowerShell/.NET) | Stub (falls back to vision) | Stub (falls back to vision) |
| Shell execution | Yes | Yes | Yes |

## Dependencies

- **@nut-tree-fork/nut-js** — cross-platform input simulation (mouse, keyboard)
- **screenshot-desktop** — native screen capture
- **sharp** — image processing (JPEG compression, resize)
- **ws** — WebSocket client for remote mode
