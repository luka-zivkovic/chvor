<p align="center">
  <img src="docs/assets/chvor-logo.png" alt="Chvor" width="80" />
</p>

<h1 align="center">Chvor</h1>

<p align="center">
  <strong>The AI you can see think.</strong><br />
  <sub>Open-source. Self-hosted. Learns permanently.</sub>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/INSTALL.md">Install</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://discord.gg/hvNKpYaJ2D">Discord</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-Sustainable%20Use%20v1.0-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node 22+" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D10-orange" alt="pnpm 10+" />
  <a href="https://discord.gg/hvNKpYaJ2D"><img src="https://img.shields.io/badge/discord-join-7289da" alt="Discord" /></a>
</p>

---

An open-source AI platform that runs on your machine and shows you how it thinks. Every skill, tool, and decision is visible on a living brain canvas. It learns permanently, heals itself when things break, and gets better the more you use it.

> **Currently, Chvor runs locally.** Do not expose your instance to the public internet without authentication (`CHVOR_TOKEN`). **Agent mode** — public-facing with built-in auth and rate limiting — is coming soon.

---

## Quick Start

**One command** — installs Node.js if needed, sets up everything, and launches the onboarding wizard:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.ps1 | iex
```

**After install:**

```bash
chvor start       # Start the server
chvor stop        # Stop the server
chvor update      # Update to the latest version
```

Open **http://localhost:3001** — you'll see the brain canvas.

<details>
<summary><strong>Other install methods</strong></summary>

### npm

```bash
npm install -g @chvor/cli
chvor onboard
```

### Docker

```bash
docker run -d --name chvor -p 3001:3001 -v ~/.chvor:/home/node/.chvor ghcr.io/luka-zivkovic/chvor:latest
```

### Docker Compose

```bash
git clone https://github.com/luka-zivkovic/chvor.git && cd chvor
docker compose up -d
```

### Desktop App <sup>experimental</sup>

Download [.msi (Windows)](https://github.com/luka-zivkovic/chvor/releases/latest) or [.dmg (macOS)](https://github.com/luka-zivkovic/chvor/releases/latest) — no terminal required.

### From Source

```bash
git clone https://github.com/luka-zivkovic/chvor.git && cd chvor
pnpm install && cp .env.example .env
pnpm dev  # opens localhost:5173
```

**Full guide:** [docs/INSTALL.md](docs/INSTALL.md)

</details>

---

## Features

### Brain Canvas

A real-time visualization of your AI's reasoning. Every skill activation, tool call, and decision branch animates on an interactive node graph — not after the fact, but as it happens.

### Multi-Channel

One AI, everywhere. Web Chat, Telegram, Discord, Slack, WhatsApp — same personality, same memory, same context across all channels.

### MCP-Native Tools

Built on the [Model Context Protocol](https://modelcontextprotocol.io). Connect any MCP server as a tool — filesystem, web search, databases, code execution. Tools auto-discover and appear on the canvas.

### Skills & Personality

Skills define behavior with YAML — personality, trigger patterns, tool bindings, rules. Give your AI a name, a tone, and directives it always follows. No two Chvors are alike.

### Cognitive Memory

Not a simple vector store. A graph-based cognitive architecture with spaced repetition, emotional awareness, consolidation cycles, and predictive retrieval. Your AI learns permanently — important things strengthen, the rest fades naturally.

### Self-Healing

When a tool fails or a skill errors, Chvor detects the issue, retries with adjusted parameters, and recovers gracefully. Your AI doesn't crash — it adapts. All visible on the brain canvas.

### Emotion Engine

Sentiment-aware responses. Your AI reads the conversation context and adapts its tone — more empathetic when you're frustrated, more concise when you're in a hurry.

### Scheduled Tasks

Cron-based automations. Your AI runs tasks on a schedule and delivers results to any channel — daily summaries, monitoring alerts, reminders.

### Encrypted at Rest

API keys and credentials stored with AES-256-GCM encryption. Zero plaintext storage. All data stays on your machine.

---

## Architecture

```
                     ┌──────────────────┐
                     │   Brain Canvas   │  React Flow
                     │  (Vite + React)  │  Real-time execution viz
                     └────────┬─────────┘
                              │ WebSocket
                     ┌────────┴─────────┐
                     │     Gateway      │  Hono + Node.js
                     │   Orchestrator   │  LLM routing, MCP, tools
                     └────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────┴─────┐  ┌─────┴─────┐  ┌──────┴──────┐
        │  Web Chat  │  │ Telegram  │  │   Discord   │
        └───────────┘  └───────────┘  └─────────────┘
```

**Monorepo** (pnpm workspaces):

| Package | Stack |
|---------|-------|
| `apps/client` | Vite + React + React Flow + Tailwind v4 + Zustand |
| `apps/server` | Hono + better-sqlite3 + Vercel AI SDK |
| `packages/shared` | Shared TypeScript types |

---

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

---

## Documentation

| Doc | Description |
|-----|-------------|
| **[Installation](docs/INSTALL.md)** | CLI, desktop app, Docker, npm, source |
| **[Memory System](docs/MEMORY.md)** | Graph-based cognitive memory with decay & consolidation |
| **[Channels](docs/CHANNELS.md)** | Telegram, Discord, Slack, WhatsApp integration |
| **[Skills & Tools](docs/SKILLS-AND-TOOLS.md)** | Skill system, MCP tools, and registry |
| **[Brain Canvas](docs/CANVAS.md)** | Real-time execution visualizer |
| [Schedules](docs/SCHEDULES.md) | Cron-based automation |
| [Browser](docs/BROWSER.md) | Web agent and HTTP browse automation |
| [PC Control](docs/PC-CONTROL.md) | Screen control with vision pipeline |
| [Knowledge](docs/KNOWLEDGE.md) | Document ingestion and fact extraction |
| [Voice](docs/VOICE.md) | Speech-to-text and text-to-speech |
| [Emotions](docs/EMOTIONS.md) | VAD emotion model and personality presets |
| [Webhooks](docs/WEBHOOKS.md) | GitHub, Notion, Gmail webhook subscriptions |
| [Registry](docs/REGISTRY.md) | Skill/tool registry and publishing |
| [Security](SECURITY.md) | Security policy and self-hosting practices |

**Landing page & web docs:** [chvor.dev](https://chvor.dev) · [chvor.dev/docs](https://chvor.dev/docs)

---

## Roadmap

| Status | Feature |
|--------|---------|
| **Shipped** | Brain Canvas, Multi-Channel, MCP Tools, Skills, Cognitive Memory, Schedules, Emotion Engine, Self-Healing |
| **Experimental** | Desktop App (Tauri), A2UI (AI-to-UI), PC Control |
| **In Progress** | Skill Registry, Templates |
| **Planned** | Agent Mode, Team Workspaces, Voice Channels, Plugin SDK, Fine-tuning, Mobile App |

See the full [roadmap on chvor.dev](https://chvor.dev/roadmap).

---

## Community

- **[Discord](https://discord.gg/hvNKpYaJ2D)** — Chat, ask questions, share builds
- **[GitHub Issues](https://github.com/luka-zivkovic/chvor/issues)** — Bug reports, feature requests
- **[Contributing](CONTRIBUTING.md)** — Setup instructions and guidelines
- **Email** — lukazivkovic58@gmail.com

Good places to start contributing:
- Issues labeled `good first issue`
- New MCP tool integrations
- Documentation improvements

---

## License

Chvor is source-available under the [Chvor Sustainable Use License v1.0](LICENSE.md).

- Personal use, self-hosting, internal business use — **fully free**
- Consulting and building workflows for clients — **allowed**
- Offering as a competing SaaS or embedding in a commercial product — **requires a commercial agreement**

---

<p align="center">
  <img src="docs/assets/chvor-logo.png" alt="" width="24" />
  <br />
  <strong>The AI you can see think.</strong><br />
  <a href="https://chvor.dev">chvor.dev</a> · <a href="https://discord.gg/hvNKpYaJ2D">Discord</a> · <a href="https://github.com/luka-zivkovic/chvor">GitHub</a>
</p>
