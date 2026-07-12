# Chvor Architecture

This document is the **mental-model entrypoint** for new contributors. It explains how a message flows from a user through the system, how the major layers fit together, and how to extend Chvor with new skills, channels, and tools without grepping for hours.

For end-user features, start with the [README](../README.md) and the per-feature docs in this folder (`SKILLS-AND-TOOLS.md`, `MEMORY.md`, `CHANNELS.md`, etc.). This file is for people who want to **change** the code.

---

## 1. The 30-second tour

Chvor is a self-hosted AI orchestrator. A single Hono server (`apps/server`) holds:

- a **WebSocket gateway** (`gateway/ws.ts`) — every client speaks one protocol
- an **orchestrator** (`lib/orchestrator.ts`) — the LLM tool-loop that drives every reply
- 22 **native tools** under `lib/native-tools/` (skills, schedules, webhooks, browser, shell, credentials, OpenAPI synthesis, etc.)
- a **SQLite layer** (`db/`) with 26 stores — encrypted credentials (AES-256-GCM), graph memory, configs, activity log, etc.
- 8 **channels** (`channels/*.ts`) — Telegram, Discord, Slack, WhatsApp, Matrix, plus the in-app web chat

The Vite client (`apps/client`) is a React 19 + Zustand SPA built around a React Flow **brain canvas**. It receives `execution.event` messages over WebSocket and animates the corresponding canvas node.

A Tauri shell (`apps/desktop`) packages the client + spawns the server as a child process.

A pnpm workspace ties the four apps + `packages/{shared,cli,pc-agent}` together. `node-linker=hoisted`, so all dependencies live at the root `node_modules/`.

---

## 2. Message flow — what happens when you type "hello"

```
┌───────────┐  WS chat.send  ┌──────────┐  handleClientEvent  ┌──────────────┐
│  Browser  │ ─────────────▶ │ Gateway  │ ─────────────────▶  │ Orchestrator │
└───────────┘                └──────────┘                     └──────┬───────┘
       ▲                                                              │
       │  WS chat.chunk + execution.event ◀──────────────────────────┤
       │                                                              │
       │                                                       calls AI SDK
       │                                                              │
       │                                                       streams reply
       │                                                              │
       │                                                       runs tool loop
       │                                                              │
       │                                                       writes memory
       │                                                              ▼
       │                                                       ┌──────────┐
       └───────────────────── chat.message (final) ─────────── │  Stores  │
                                                                └──────────┘
```

Step by step:

1. **Client** (`hooks/use-gateway.ts`) opens `wss://host/ws`, sends `session.init` with a stable per-browser UUID, then a `chat.send`.
2. **`gateway/ws.ts`** validates the event against `VALID_CLIENT_EVENT_TYPES`, dispatches to a registered handler.
3. **`gateway/gateway.ts`** routes `chat.send` to the orchestrator with the client ID + session ID context.
4. **`lib/orchestrator.ts`** — the heart of the system. Loads enabled skills + tools (`tool-builder.ts`), composes a system prompt (`getCoreIdentity` + persona + memory snippets), and calls the AI SDK's `streamText` with `tools` enabled.
5. The AI SDK streams chunks. Each `text-delta` becomes a `chat.chunk` WS message. Tool calls become `execution.event`s with `phase: "running" → "completed" | "failed"`, which animate the matching canvas node.
6. When the model emits a `tool-call`, the orchestrator looks it up in `getNativeToolDefinitions()` (or the registered MCP/skill tool), runs the handler, and feeds the result back to the model in the next round-trip. Up to N tool rounds per message (configured in orchestrator).
7. After the final `text-delta`, orchestrator writes the assistant message to the session store, runs the **emotion parser** (`emotion-parser.ts`) on the reply text, fires `chat.streamEnd`, and flushes any pending `memory.write` extractions.
8. The browser renders the streamed message in `ChatPanel`, the canvas continues showing tool node animations until each tool's `completed` event lands.

B11 does not change this message flow. Structured memory blocks are persisted and
managed through an authenticated HTTP API, but the orchestrator does not retrieve
or inject them. Runtime context assembly belongs to B12, and the inspector UI
belongs to B13.

**Key file paths:**

| Step            | File                                                |
| --------------- | --------------------------------------------------- |
| WS dispatch     | `apps/server/src/gateway/ws.ts`                     |
| Event routing   | `apps/server/src/gateway/gateway.ts`                |
| Orchestration   | `apps/server/src/lib/orchestrator.ts`               |
| Tool registry   | `apps/server/src/lib/tool-builder.ts`               |
| Native tools    | `apps/server/src/lib/native-tools/`                 |
| Stream → canvas | `apps/client/src/hooks/use-execution.ts`            |
| Canvas state    | `apps/client/src/stores/canvas-store.ts`            |
| Render          | `apps/client/src/components/canvas/BrainCanvas.tsx` |

---

## 3. Layering at a glance

```
                        ┌─────────────────────────────┐
                        │  apps/desktop (Tauri shell) │
                        └──────────────┬──────────────┘
                                       │ spawns
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐            ┌───────────────────┐         ┌──────────────────┐
│ apps/client   │   ws/http  │ apps/server       │  spawn  │ packages/pc-agent│
│ React + Vite  │◀──────────▶│ Hono + WS         │◀───────▶│ Local controller │
└───────┬───────┘            └─────────┬─────────┘         └──────────────────┘
        │                              │
        │                              │  imports
        ▼                              ▼
┌───────────────┐            ┌─────────────────────┐
│ packages/     │◀───────────│ packages/shared     │
│   cli         │            │ Types + zod schemas │
└───────────────┘            └─────────────────────┘
```

**Server modules** (`apps/server/src/`):

```
src/
├── index.ts                  Bootstrap: env, DB, routes, channels, gateway, graceful shutdown
├── gateway/                  WS protocol layer
│   ├── ws.ts                   WSManager — connection registry, heartbeat, eviction
│   └── gateway.ts              Per-event router (chat.send, command.respond, …)
├── orchestrator               (in lib/orchestrator.ts) — LLM tool loop
├── routes/                   38 HTTP route files, one per resource (REST)
├── channels/                 7 channel adapters + base channel.ts
├── middleware/               auth, rate-limit, request-logger
├── db/
│   ├── database.ts             Migrations + pragma + connection
│   ├── crypto.ts               AES-256-GCM (envelope-encrypted credentials)
│   ├── memory-block-store.ts    Bounded snapshots, revisions, restore, concurrency
│   ├── migrations/
│   │   └── memory-blocks-v35.ts Structured-block tables and invariants
│   ├── config-store.ts         Re-export shim → config/
│   ├── config/                 14 split config domains (persona, models, brain, …)
│   └── *-store.ts              26 stores (memory, schedule, webhook, …)
└── lib/
    ├── orchestrator.ts         Tool loop, fallback chain, emotion parse, memory write
    ├── native-tools.ts         Re-export shim → native-tools/
    ├── native-tools/           21 split tool modules
    ├── synthesized-caller.ts   Tier-3 OpenAPI tool execution + safety gates
    ├── approval-gate.ts        Per-call approval state for synthesized + shell tools
    ├── pending-intent.ts       Deferred-task continuation across credential dance
    ├── credential-resolver.ts  3-tier integration discovery
    ├── integration-research.ts Tier-3 web-scrape + AI-inference fallback
    ├── spec-fetcher.ts         OpenAPI URL probing + APIs.guru lookup
    ├── memory-*.ts             Graph-based cognitive memory subsystem
    ├── emotion-*.ts            VAD emotion engine
    └── errors.ts               Custom error hierarchy + serializer
```

**Client modules** (`apps/client/src/`):

```
src/
├── App.tsx                   Root, mounts MainLayout + ErrorBoundary
├── components/
│   ├── ErrorBoundary.tsx       Global + inline boundaries
│   ├── canvas/                 BrainCanvas + 16 node types
│   ├── chat/                   ChatPanel, message list, composer
│   ├── panels/                 SlideOverPanel content (skills, tools, …)
│   ├── a2ui/                   Server-driven UI renderer (allowlisted)
│   └── layout/                 MainLayout, Sidebar, TopBar
├── hooks/
│   ├── use-gateway.ts          WS lifecycle + heartbeat + reconnect
│   └── use-execution.ts        Subscribes to execution.event → canvas
├── stores/                   Zustand stores (24, mid-consolidation)
└── lib/
    ├── orbital-geometry.ts     Pure layout fns for the brain canvas
    ├── api.ts                  REST helpers
    └── thought-stream/         Floating-thought rendering
```

---

## 4. Persistence — what's where

SQLite is the single source of truth on disk. It lives at `~/.chvor/chvor.db` (override with `CHVOR_DATA_DIR`).

| Store                                     | Purpose                                                                       | Encrypted?         |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| `auth-store`                              | Session cookies, password hash                                                | password hashed    |
| `api-key-store`                           | Server API keys (Bearer)                                                      | hashed             |
| `credential-store`                        | All third-party creds                                                         | yes (AES-256-GCM)  |
| `synthesized-store`                       | Tier-3 spec cache + approval state                                            | no (only metadata) |
| `memory-store`                            | Graph nodes + edges (semantic memory)                                         | no                 |
| `memory-block-store`                      | Stable identity/human/procedural blocks and immutable full-snapshot revisions | no                 |
| `emotion-store` + `emotion-residue-store` | VAD scores per turn                                                           | no                 |
| `relationship-store`                      | People-mention frequency / sentiment                                          | no                 |
| `session-store`                           | Conversations + messages                                                      | no                 |
| `schedule-store`                          | Cron + interval triggers                                                      | no                 |
| `webhook-store`                           | Inbound webhook secrets                                                       | secrets hashed     |
| `knowledge-store`                         | Ingested documents + chunks + embeddings                                      | no                 |
| `activity-store`                          | Audit trail (every tool call, every webhook)                                  | no                 |
| `daemon-store`                            | Daemon presence + tasks                                                       | no                 |
| `workspace-store`                         | React Flow node/edge JSON + viewport                                          | no                 |
| `a2ui-store`                              | Server-pushed UI surfaces                                                     | no                 |
| `job-store`                               | Background job queue                                                          | no                 |
| `config/*`                                | Per-domain config (persona, models, brain, channels, …)                       | no                 |

Graph memory and structured blocks are separate persistence models. Migration v35
creates `memory_blocks` and `memory_block_revisions`, advances `user_version` only
after its schema transaction succeeds, and performs no graph-memory backfill. The
store enforces Unicode code-point limits, immutable layer/manager identity,
full-snapshot revisions, restore provenance, read-only agent guards, and optimistic
`expectedRevision` writes. See
[`structured-memory-blocks.md`](structured-memory-blocks.md) for the full contract.

The crypto envelope: `db/crypto.ts` derives a per-install master key from `~/.chvor/master.key` (created on first boot). Each ciphertext stores `iv || authTag || ciphertext`. Decryption is lazy — the credential blob is only decrypted at use time, never broadcast.

---

## 5. Configuration

Config lives in SQLite under the `config` table — flat KV pairs with dotted keys (`persona.name`, `models.role.heavy.providerId`, etc.). The `db/config/*.ts` modules are typed accessors for each domain.

Reads pass through process-level caches where helpful (e.g. `getSelfHealingEnabled()` is hot path in `getNativeToolDefinitions()`). Writes go straight to SQLite + invalidate the cache.

To add a new config domain: create `db/config/<domain>.ts`, add the typed getters/setters, then re-export from `db/config/index.ts`. Consumers continue importing from `db/config-store.ts` which forwards to the index.

---

## 6. The integration "tool" universe

There are **three tiers** of tools the LLM can call:

| Tier                     | Where                                             | Examples                                                        | When to use                                         |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- |
| 1. Native                | `lib/native-tools/<domain>.ts`                    | `web_request`, `shell_execute`, `recall_detail`, `create_skill` | Built-in capabilities Chvor ships with              |
| 2. MCP                   | External MCP servers                              | Anything an MCP server exposes                                  | Trusted, vetted tooling                             |
| 3. Synthesized (OpenAPI) | `lib/synthesized-caller.ts` + `synthesized-store` | Any REST API discovered via OpenAPI                             | "Pull my QuickBooks invoice" — discovered on demand |

All three tiers funnel through `tool-builder.ts`, which assembles the AI SDK `tools` map for the orchestrator.

**Tier-3 flow:**

```
"pull my Linear issues"
   │
   ▼
LLM → research_integration("linear")
   │
   ▼
integration-resolver.ts:
  Tier 1 (provider-registry) → miss
  Tier 2 (chvor-registry)    → miss
  Tier 3 (integration-research.ts):
    - DDG/APIs.guru/GitHub spec search
    - LLM extracts {name, credentialType, fields, baseUrl, authScheme, specUrl}
   │
   ▼
LLM → request_credential(...)  (or request_oauth_setup if OAuth)
   │
   ▼
Client modal asks user for the secret(s)
   │
   ▼
Encrypted into credential-store
   │
   ▼
Spec parsed → tier-3 tool definitions registered
   │
   ▼
LLM calls the synthesized tool → synthesized-caller.ts:
  - HTTPS-only, SSRF-pinned DNS, repair budget, approval gate for non-GET
   │
   ▼
Response back to model → final reply
```

Resume-after-creds is handled by `pending-intent.ts`: when `request_credential` is invoked mid-task, the user's original intent gets recorded; on credential.success, the orchestrator re-fires the original message with a "credentials acquired — continue" system note.

---

## 7. How to add things

### 7.1 Add a new skill

Skills are bundled YAML/Markdown files under `apps/server/src/skills/` (and user skills under `~/.chvor/skills/`).

1. Create `apps/server/src/skills/<your-skill>/skill.md` with frontmatter:

```yaml
---
id: your-skill
name: Your Skill
description: One-line user-facing pitch
icon: spark # any lucide-react icon name
trigger: "When the user wants to do X..."
category: general # general | productivity | knowledge | …
tags: [foo, bar]
---
# Skill body (system prompt)
You are a Y. When invoked, do Z.
```

2. (Optional) Add `instructions/*.md` for per-trigger sub-instructions.
3. Restart the server. `capability-loader.ts` reads the directory at boot and after `skills.reloaded` events.
4. Toggle the skill on in the **Skills** panel.

To make the skill always-active without a trigger, set `trigger: ""`. To gate by capability, the existing `isCapabilityEnabled("skill", "<id>")` check governs visibility to the LLM.

### 7.2 Add a new channel

A channel is a class implementing `BaseChannel` from `apps/server/src/channels/channel.ts`. The class:

- `start()` — connect to the third-party platform, register a message handler that pipes inbound messages into `gateway.handleChannelMessage(channel, sender, text)`
- `send(channelId, text)` — send a reply
- `stop()` — clean shutdown

1. Create `apps/server/src/channels/<your-channel>.ts` extending `BaseChannel`.
2. Wire it into `apps/server/src/index.ts` next to the existing `if (TELEGRAM_BOT_TOKEN) { ... }` blocks.
3. Add a route under `apps/server/src/routes/<your-channel>.ts` for setup/auth if needed.
4. Update `db/config/channels.ts` if your channel needs per-channel policy (DM vs. group, allowlists).
5. Add the credential type to the credential modal flow (`packages/shared/src/types/credential.ts`).

The orchestrator doesn't care which channel a message came from — it routes through the same `chat.send` flow with `channelType` in the context.

### 7.3 Add a new native tool

A native tool is a function the LLM can call directly without leaving the server.

1. Pick the right module under `apps/server/src/lib/native-tools/` (e.g. `web.ts`, `productivity.ts`, `system.ts`) — or create a new one.
2. Define the tool:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { NativeToolHandler, NativeToolModule } from "./types.ts";

export const MY_TOOL_NAME = "native__my_tool";

const myToolDef = tool({
  description: "When to call this tool — phrased as the LLM sees it.",
  inputSchema: z.object({
    foo: z.string().describe("What foo means"),
  }),
});

const handleMyTool: NativeToolHandler = async (args, context) => {
  const { foo } = args as { foo: string };
  // … do the work, optionally use context.sessionId / context.emitEvent
  return { content: [{ type: "text", text: `Did the thing with ${foo}` }] };
};

export const myToolModule: NativeToolModule = {
  defs: { [MY_TOOL_NAME]: myToolDef },
  handlers: { [MY_TOOL_NAME]: handleMyTool },
  // Optional: gate visibility via runtime predicate
  // enabled: () => isCapabilityEnabled("tool", "my-tool"),
};
```

3. Register the module in `apps/server/src/lib/native-tools/index.ts` by adding it to the `ALL_MODULES` array.
4. Run `pnpm --filter @chvor/server typecheck && pnpm --filter @chvor/server test` to verify.
5. The new tool is now in `getNativeToolDefinitions()` and dispatched by `callNativeTool()` automatically. No other consumer needs to change.

### 7.4 Add a tier-3 OpenAPI integration (no code change)

For most third-party APIs you don't write code at all. Just ask the AI:

> "Add a Linear integration and pull my issues."

It will: search the registry, ask for credentials, fetch the OpenAPI spec, present a `synthesized.confirm` modal, then call the API. If the spec is correct, it'll work. If you want it cached for next session, the user can hit "Allow for this session" in the modal.

For OAuth services (QuickBooks-style), the OAuth wizard captures the user's client_id / client_secret, opens the browser, captures the callback at `/oauth/synthesized/callback/:credentialType`, and stores the refresh token. From then on, calls auto-refresh on 401.

---

## 8. WebSocket protocol (gateway events)

Every client ↔ server message is one of these typed shapes (defined in `packages/shared/src/types/api.ts`):

**Client → server:**

| type                        | data                                        | When                            |
| --------------------------- | ------------------------------------------- | ------------------------------- |
| `session.init`              | `{ sessionId }`                             | First message after connect     |
| `chat.send`                 | `{ text, workspaceId, media?, messageId? }` | User submits a message          |
| `chat.stop`                 | `{}`                                        | User clicks "Stop generating"   |
| `command.respond`           | `{ requestId, approved }`                   | Approval modal response (shell) |
| `credential.respond`        | `{ requestId, cancelled, data? }`           | Credential modal response       |
| `synthesized.respond`       | `{ requestId, decision }`                   | OpenAPI call approval           |
| `oauth.synthesized.respond` | `{ requestId, cancelled, connected? }`      | OAuth wizard response           |
| `canvas.subscribe`          | `{ workspaceId }`                           | Re-subscribe after panel switch |
| `heartbeat`                 | `{}`                                        | Liveness ping (15s interval)    |

**Server → client** (highlights):

| type                                                                                          | When                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `chat.chunk` / `chat.streamEnd`                                                               | Streaming response chunk + final marker              |
| `chat.message`                                                                                | Final assistant message (durable)                    |
| `execution.event`                                                                             | Tool call started/completed/failed → animates canvas |
| `command.confirm` / `credential.request` / `synthesized.confirm` / `oauth.synthesized.wizard` | Server-triggered modals                              |
| `activity.new`                                                                                | Audit log entry — appended to Activity panel         |
| `a2ui.surface` / `a2ui.data` / `a2ui.delete`                                                  | Server-driven UI updates                             |
| `webhook.received`                                                                            | Inbound webhook fired                                |
| `pc.connected` / `pc.frame`                                                                   | PC-control daemon lifecycle                          |
| `heartbeat`                                                                                   | Server liveness ping                                 |

The protocol is intentionally narrow — this is one of the few hard rules. New event types must add a discriminated case to both `GatewayClientEvent` / `GatewayServerEvent` unions in `packages/shared/src/types/api.ts`, and update the `VALID_CLIENT_EVENT_TYPES` allowlist + validator in `gateway/ws.ts`.

---

## 9. Security — what's enforced where

| Concern                   | Enforcement                                                                                                                                                       | File                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Auth (cookie + API key)   | `chvorAuth` middleware                                                                                                                                            | `middleware/auth.ts`                                                        |
| Brute-force protection    | per-IP lockout on auth                                                                                                                                            | `middleware/auth.ts`                                                        |
| Rate limiting             | token bucket per session                                                                                                                                          | `middleware/rate-limit.ts`                                                  |
| Request logging           | pino, with secret redaction                                                                                                                                       | `middleware/request-logger.ts`, `lib/logger.ts`                             |
| SSRF (synthesized calls)  | DNS-pinned HTTPS, no private IPs                                                                                                                                  | `lib/synthesized-caller.ts`, `lib/url-safety.ts`                            |
| SSRF (web fetch)          | same gates via `validateFetchUrl`                                                                                                                                 | `lib/native-tools/security.ts`                                              |
| Credential at rest        | AES-256-GCM envelope encryption                                                                                                                                   | `db/crypto.ts`                                                              |
| Shell command approval    | per-command approval gate                                                                                                                                         | `lib/native-tools/shell.ts`                                                 |
| Synthesized call approval | per-call approval (allow once / session)                                                                                                                          | `lib/approval-gate.ts`                                                      |
| YAML parsing (OpenAPI)    | billion-laughs guarded (`maxAliasCount: 0`)                                                                                                                       | `lib/spec-fetcher.ts`                                                       |
| A2UI action targets       | allowlisted parser, raw URLs rejected                                                                                                                             | `packages/shared/src/lib/a2ui-action.ts`                                    |
| Structured memory blocks  | dedicated `memory-block:read`/`memory-block:write` scopes, no-store responses, strict body/snapshot bounds, optimistic revisions, metadata-only operational audit | `routes/memory-blocks.ts`, `middleware/auth.ts`, `db/memory-block-store.ts` |
| Error responses           | structured serializer, no stack in prod                                                                                                                           | `lib/errors.ts` + `app.onError`                                             |

---

## 10. Tests + CI

- `pnpm test` runs vitest across all workspaces.
- Server tests (~187) live in `apps/server/src/**/__tests__/` — they hit a real SQLite (no DB mocks; user's preference: `feedback_no_shortcuts.md`).
- Client tests live in `apps/client/src/**/__tests__/` — pure-function tests (e.g. `orbital-geometry.test.ts`).
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` are all in `.github/workflows/ci.yml` — every PR runs them.

When adding a feature: write the test first if it has any non-obvious branch, edge case, or invariant. Hand-test the UI in the browser before claiming the task is done — the user has explicitly asked for this.

---

## 11. Where to look when something breaks

| Symptom                       | Look here first                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| WS won't connect              | `gateway/ws.ts`, browser console for `[ws]` lines                                                    |
| LLM call hangs                | `lib/orchestrator.ts` (fallback chain), provider-side rate limits                                    |
| Tool didn't fire              | `lib/native-tools/index.ts` (is it registered?), `tool-builder.ts` (is it enabled?)                  |
| Credential modal didn't open  | `lib/native-tools/credential.ts` (request flow), client `credential-store.ts`                        |
| Canvas didn't animate         | `hooks/use-execution.ts`, `stores/canvas-store.ts`, the matching `execution.event` in WS frames      |
| Memory recall returns nothing | `db/memory-store.ts`, embedder availability (`lib/embedder.ts` lazy-loads)                           |
| Channel didn't deliver        | The channel adapter file (`channels/<name>.ts`) and its env vars                                     |
| Tier-3 tool failed            | Activity log entry → `lib/synthesized-caller.ts` for the request, `lib/spec-fetcher.ts` for the spec |

---

## 12. Conventions worth knowing

- **No emojis in code or docs** unless explicitly requested.
- **No comments explaining what code does** — the function names should. Comments are for _why_ (a hidden constraint, a workaround, an invariant). See per-project rules in CLAUDE.md.
- **`.ts` extensions on all relative imports** — the project uses NodeNext-style ESM.
- **Shared types live in `packages/shared/src/types/`** and are imported via `@chvor/shared` everywhere. Don't duplicate type definitions in `apps/`.
- **Env vars are read at boot only**, never per-request. `apps/server/src/index.ts` is the single entry point for `process.env.*` reads.
- **No mocking the database in tests** — see `feedback_no_shortcuts.md`. Tests use a fresh SQLite via `database.ts`'s test-mode init.
- **Errors that reach the client must go through `serializeError()`** — that's what redacts secrets and strips stack traces in non-debug runs.

---

## 13. Pointers to deeper docs

- [`SKILLS-AND-TOOLS.md`](SKILLS-AND-TOOLS.md) — skill/tool authoring
- [`CHANNELS.md`](CHANNELS.md) — multi-channel setup (Telegram, Discord, …)
- [`MEMORY.md`](MEMORY.md) — graph memory plus its relationship to stable structured blocks
- [`structured-memory-blocks.md`](structured-memory-blocks.md) — authoritative B11 schema, API, revisions, security, audit, and migration contract
- [`CONTEXT.md`](CONTEXT.md) — authoritative six-layer context hierarchy and context assembly policy
- [`EMOTIONS.md`](EMOTIONS.md) — VAD engine + canvas color mapping
- [`CANVAS.md`](CANVAS.md) — node types, layout, status transitions
- [`A2UI.md`](A2UI.md) — server-driven UI protocol
- [`KNOWLEDGE.md`](KNOWLEDGE.md) — document ingestion pipeline
- [`REGISTRY.md`](REGISTRY.md) — installable skills & tools registry
- [`SCHEDULES.md`](SCHEDULES.md) — cron + interval scheduling
- [`WEBHOOKS.md`](WEBHOOKS.md) — inbound webhook security model
- [`PC-CONTROL.md`](PC-CONTROL.md) — local PC-agent + remote agents
- [`BROWSER.md`](BROWSER.md) — Stagehand browser automation
- [`VOICE.md`](VOICE.md) — STT / TTS providers and fallback
- [`INSTALL.md`](INSTALL.md) — first-time install + env vars

When in doubt, grep for the symptom string. Chvor is small enough that `git grep "weird error message"` usually lands you within two file-jumps of the answer.
