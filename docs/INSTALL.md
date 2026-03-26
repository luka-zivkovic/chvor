# Installing Chvor

There are several ways to install and run Chvor depending on your comfort level and platform.

---

## Option 1: One-Command Install (Recommended)

The fastest way to get running. A single command installs Node.js (if needed), downloads Chvor, and launches the onboarding wizard.

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.ps1 | iex
```

**What it does:**

1. Checks for Node.js 22+ — installs it via Homebrew (macOS), NodeSource (Linux), or winget/Chocolatey/Scoop (Windows) if missing
2. Runs `npm install -g chvor`
3. Launches `chvor onboard` — an interactive wizard that asks for your LLM provider, API key, and port
4. Downloads the latest release, starts the server, and opens `http://localhost:3001`

**After install, useful commands:**

```bash
chvor start       # Start the server
chvor stop        # Stop the server
chvor update      # Update to the latest version
chvor --help      # See all commands
```

---

## Option 2: Desktop App (GUI — No Terminal)

Download the native desktop app. Double-click to install — a setup wizard handles everything.

### Downloads

| Platform | Download |
|----------|----------|
| Windows | [Chvor-Setup.msi](https://github.com/luka-zivkovic/chvor/releases/latest) |
| macOS (Universal) | [Chvor.dmg](https://github.com/luka-zivkovic/chvor/releases/latest) |

### What it does

1. **Setup Wizard** — detects/installs Node.js, asks for your LLM provider and API key
2. **Downloads Chvor** — fetches the latest release with progress bar and checksum verification
3. **Starts the server** — runs Chvor in the background, accessible at `http://localhost:3001`
4. **System tray** — start/stop the server, open the browser, check for updates — all from the tray icon
5. **Auto-updates** — the desktop app and the Chvor server can both be updated with one click

Built with Tauri 2.0 (Rust + React). The app is ~6MB — it manages the server as an external process, not an embedded runtime.

---

## Option 3: npm

If you already have Node.js 22+:

```bash
npm install -g chvor
chvor onboard
```

This installs the `chvor` CLI globally. The `onboard` command walks you through setup.

---

## Option 4: Docker

Run Chvor in a container with persistent data.

### One-command Docker

```bash
curl -fsSL https://raw.githubusercontent.com/luka-zivkovic/chvor/main/scripts/install.sh | bash -s -- --docker
```

### Manual Docker

```bash
docker pull ghcr.io/luka-zivkovic/chvor:latest

docker run -d \
  --name chvor \
  -p 3001:3001 \
  -v ~/.chvor:/home/node/.chvor \
  ghcr.io/luka-zivkovic/chvor:latest
```

### Docker Compose

```bash
git clone https://github.com/luka-zivkovic/chvor.git
cd chvor
docker compose up -d
```

Open `http://localhost:3001` and configure your AI through the web UI.

**Image:** `ghcr.io/luka-zivkovic/chvor:latest` — multi-platform (linux/amd64, linux/arm64).

---

## Option 5: From Source (Development)

For contributors or anyone who wants to run from source.

**Prerequisites:** Node.js 22+, pnpm 10+

```bash
git clone https://github.com/luka-zivkovic/chvor.git
cd chvor
pnpm install
cp .env.example .env
# Edit .env — add at least one: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY
pnpm dev
```

Open `http://localhost:5173`. The client dev server proxies API calls to the server on port 3001.

---

## Comparison

| Method | Best for | Terminal needed | Auto-update | Platforms |
|--------|----------|-----------------|-------------|-----------|
| **One-command** | Most users | Yes (one time) | `chvor update` | macOS, Linux, Windows |
| **Desktop app** | Non-technical users | No | Built-in | Windows, macOS |
| **npm** | Developers | Yes | `chvor update` | Any with Node.js |
| **Docker** | Self-hosters, servers | Yes (one time) | `docker pull` | Any with Docker |
| **From source** | Contributors | Yes | `git pull` | Any |

---

## After Installation

Regardless of how you install, you'll access Chvor through your browser at `http://localhost:3001` (or whatever port you chose during setup). From there you can:

- **Configure your AI** — name, personality, LLM provider
- **Add channels** — Telegram, Discord, Slack, WhatsApp
- **Install skills & tools** — from the built-in registry or custom MCP servers
- **Watch it think** — the brain canvas shows every decision in real-time

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | 22+ (auto-installed by one-command and desktop options) |
| OS | macOS 12+, Windows 10+, or Linux (Ubuntu 20.04+, Debian 11+) |
| RAM | 512MB minimum |
| Disk | ~500MB (including browser engine for web agent) |

## Updating

```bash
# CLI
chvor update

# Docker
docker pull ghcr.io/luka-zivkovic/chvor:latest && docker restart chvor

# Desktop app
Click "Check for Updates" in the system tray
```

## Uninstalling

```bash
# CLI
npm uninstall -g chvor
rm -rf ~/.chvor

# Docker
docker stop chvor && docker rm chvor
docker rmi ghcr.io/luka-zivkovic/chvor:latest

# Desktop app
Uninstall via system settings (Add/Remove Programs on Windows, drag to Trash on macOS)
rm -rf ~/.chvor
```
