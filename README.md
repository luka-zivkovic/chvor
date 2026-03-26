<h1 align="center">Chvor</h1>

<p align="center">
  <strong>Your own AI &mdash; built by you, visible to you, unique to you.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#contributing">Contributing</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Sustainable%20Use-blue" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D10-orange" alt="pnpm" />
</p>

---

<!-- TODO: Replace with actual demo GIF -->
<!-- <p align="center"><img src="docs/demo.gif" width="720" /></p> -->

> ChatGPT is everyone's AI. **Chvor is yours.**

Every AI assistant today is the same. Same interface, same personality, same black box. Chvor is different &mdash; you give it a name, a personality, wire it to your tools, and **watch it think** on a living brain canvas. Talk to it from the web, Telegram, Discord, or Slack. No two Chvors are alike.

## Features

**See your AI think** &mdash; A real-time brain canvas shows every skill, tool, and decision as it happens. Edges animate during execution. It's mission control for your AI.

**Multi-channel** &mdash; One AI, everywhere. Chat from the web UI, Telegram, Discord, or Slack. Same personality, same memory, same context across all channels.

**MCP-native** &mdash; Built on the [Model Context Protocol](https://modelcontextprotocol.io). Connect any MCP server as a tool. Filesystem, web search, databases &mdash; your AI can use them all.

**Skills & Tools** &mdash; Skills define behavior (personality, workflows). Tools provide capabilities (MCP servers, built-in utilities). Mix and match to build your perfect AI.

**Visual orchestration** &mdash; Two modes: *Constellation* (AI decides what to use) and *Pipeline* (you wire nodes manually). Switch between autonomous and controlled execution.

**Memory & personality** &mdash; Your AI remembers conversations, learns your preferences, and follows your directives. Give it a name, a tone, and rules to live by.

**Scheduled tasks** &mdash; Set up cron-based automations. Your AI can run tasks on a schedule and deliver results to any channel.

**Encrypted credentials** &mdash; API keys stored with AES-256-GCM encryption. Manage them through the UI or environment variables.

## Quick Start

### One-command install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.sh | bash
```

### One-command install (Windows PowerShell)

```powershell
irm https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.ps1 | iex
```

### Or download the desktop app

No terminal needed &mdash; [download the installer](https://github.com/luka-zivkovic/chvor/releases/latest) for Windows (.msi) or macOS (.dmg).

**All install options:** See [docs/INSTALL.md](docs/INSTALL.md) for Docker, npm, from-source, and detailed setup instructions.

## Architecture

```
                     +------------------+
                     |   Brain Canvas   |  React Flow constellation
                     |  (Vite + React)  |  Real-time execution viz
                     +--------+---------+
                              |
                         WebSocket
                              |
                     +--------+---------+
                     |     Gateway      |  Hono + Node.js
                     |   Orchestrator   |  LLM routing, MCP, tools
                     +--------+---------+
                              |
              +---------------+---------------+
              |               |               |
        +-----+-----+  +-----+-----+  +------+------+
        |  Web Chat  |  | Telegram  |  |   Discord   |
        |  Channel   |  |  Channel  |  |   Channel   |
        +------------+  +-----------+  +-------------+
```

**Monorepo** (pnpm workspaces):
- `apps/client` &mdash; Vite + React + React Flow + Tailwind v4 + Zustand
- `apps/server` &mdash; Hono + better-sqlite3 + Vercel AI SDK
- `packages/shared` &mdash; Shared TypeScript types

**Key patterns:**
- All channels route through a single gateway &rarr; orchestrator &rarr; LLM
- WebSocket pushes execution events to the canvas in real-time
- Skills (behavioral) and Tools (MCP) are loaded from `~/.chvor/`
- Bundled defaults in `data/bundled-skills/` and `data/bundled-tools/`

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | One of these | Anthropic API key |
| `OPENAI_API_KEY` | One of these | OpenAI API key |
| `GOOGLE_API_KEY` | One of these | Google AI API key |
| `CHVOR_TOKEN` | No | Bearer token for API/WebSocket auth |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token (or set via UI) |
| `DISCORD_BOT_TOKEN` | No | Discord bot token (or set via UI) |
| `SLACK_BOT_TOKEN` | No | Slack bot token (or set via UI) |
| `SLACK_APP_TOKEN` | No | Slack app-level token (or set via UI) |

## Documentation

| Doc | Description |
|-----|-------------|
| [Installation](docs/INSTALL.md) | All install options (CLI, desktop app, Docker, npm, source) |
| [Memory System](docs/MEMORY.md) | Graph-based cognitive memory with decay, consolidation, and prediction |
| [Channels](docs/CHANNELS.md) | Telegram, Discord, Slack, WhatsApp, and Matrix integration |
| [Schedules](docs/SCHEDULES.md) | Cron-based automation with multi-channel delivery |
| [Skills & Tools](docs/SKILLS-AND-TOOLS.md) | Skill/tool system, bundled capabilities, MCP, and registry |
| [Browser](docs/BROWSER.md) | Web agent (Stagehand) and HTTP browse automation |
| [PC Control](docs/PC-CONTROL.md) | Screen control with 3-layer pipeline (action router, a11y, vision) |
| [Knowledge](docs/KNOWLEDGE.md) | Document ingestion (PDF, DOCX, URL, images) and fact extraction |
| [Brain Canvas](docs/CANVAS.md) | Real-time execution visualizer and interactive constellation |
| [Voice](docs/VOICE.md) | Speech-to-text and text-to-speech with multiple providers |
| [Emotions](docs/EMOTIONS.md) | VAD emotion model, personality presets, and canvas particles |
| [Webhooks](docs/WEBHOOKS.md) | GitHub, Notion, Gmail, and generic webhook subscriptions |
| [Registry](docs/REGISTRY.md) | Skill/tool registry specification and publishing |
| [Security](SECURITY.md) | Security policy, design, and self-hosting best practices |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

We welcome contributions! Good places to start:
- Issues labeled `good first issue`
- New MCP tool integrations
- Documentation improvements
- Bug reports and feature requests

## License

Chvor is source-available under the [Chvor Sustainable Use License v1.0](LICENSE.md).

**What this means:**
- **Personal use, self-hosting, internal business use:** Fully free. Go wild.
- **Consulting & building workflows for clients:** Allowed.
- **Offering as a competing SaaS or embedding in a commercial product:** Requires a commercial agreement — [contact us](https://chvor.ai).

---

<p align="center">
  <strong>See your AI think.</strong><br />
  <a href="https://chvor.ai">chvor.ai</a>
</p>
