# Skills & Tools

Chvor's capabilities are extended through **skills** (behavioral instructions) and **tools** (executable integrations). Both are defined as markdown files and can be installed from the registry, created manually, or built by the AI itself.

---

## Skills vs Tools

| | Skills | Tools |
|-|--------|-------|
| **What** | Prompt-based instructions that shape AI behavior | Executable integrations via MCP (Model Context Protocol) |
| **Example** | Code Review, Brainstorming, Writing Helper | GitHub, Web Browse, Filesystem |
| **Requires** | Nothing (just a .md file) | An MCP server (spawned as a child process) |
| **Location** | `~/.chvor/skills/` | `~/.chvor/tools/` |

---

## Bundled Skills

These come pre-installed:

| Skill | Description | Default |
|-------|-------------|---------|
| **Chvor Guide** | Teaches the AI how to explain its own features | Enabled |
| **PC Control** | Screen, mouse, keyboard, and a11y tree control | Enabled (when feature on) |
| **Code Review** | Systematic code review with actionable feedback | Disabled |
| **Brainstorming** | Creative ideation and structured brainstorming | Disabled |
| **Writing Helper** | Writing assistance with tone and style guidance | Disabled |

Enable/disable skills in the Skills panel or via API.

## Bundled Tools

| Tool | Description | Requires |
|------|-------------|----------|
| **GitHub** | Repository, PR, and issue management | GitHub token |
| **Web Browse** | DuckDuckGo search + HTTP fetch | Nothing |
| **Web Agent** | Full browser automation (Stagehand) | Chromium (auto-installed) |
| **Filesystem** | Read/write files on the server | Nothing |
| **Notion** | Notion page and database access | Notion API key |
| **Claude Code** | Code execution in sandbox | Anthropic API key |
| **Context7** | Library documentation lookup | Nothing |

---

## Installing from the Registry

Browse and install community skills/tools:

### Via Chat

> "Search the registry for a Jira skill"

> "Install the web-search skill"

### Via UI

1. Open the **Skills** or **Tools** panel
2. Click **Browse Registry**
3. Search, filter by category, and click **Install**

### Via API

```bash
# Search
curl "http://localhost:3001/api/registry/search?q=github&category=developer"

# Install
curl -X POST http://localhost:3001/api/registry/install \
  -H 'Content-Type: application/json' \
  -d '{"skillId": "web-search"}'
```

---

## Creating Custom Skills

Create a markdown file in `~/.chvor/skills/`:

```markdown
---
name: My Custom Skill
description: Does something useful
version: 1.0.0
category: productivity
icon: star
type: prompt
---

When the user asks about X, follow these steps:

1. First, check Y
2. Then do Z
3. Always format output as a table
```

The skill is automatically loaded (hot-reload on file changes).

### Skill Types

| Type | Description |
|------|-------------|
| `prompt` | Instructions injected into the system prompt |
| `workflow` | Multi-step procedure with native tool calls |

---

## Creating Custom Tools

Tools require an MCP server. Create a markdown file in `~/.chvor/tools/`:

```markdown
---
name: My API Tool
description: Interact with My API
version: 1.0.0
category: developer
type: tool
mcp:
  command: npx
  args: ["-y", "my-mcp-server"]
  transport: stdio
  env:
    MY_API_KEY: "{{credentials.my-api}}"
requires:
  credentials:
    - my-api
---

Instructions for the AI on how to use this tool.
```

The `{{credentials.my-api}}` placeholder is resolved from saved credentials at runtime.

---

## Skill Configuration

Skills can declare configurable parameters:

```yaml
config:
  - name: maxResults
    type: number
    description: Maximum results to return
    default: 10
  - name: style
    type: string
    description: Output style
    default: detailed
```

Users can set these in the skill detail panel or via API.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/skills` | List all skills |
| `GET` | `/api/skills/:id` | Get skill details |
| `PATCH` | `/api/skills/:id` | Enable/disable skill |
| `GET` | `/api/tools` | List all tools |
| `GET` | `/api/tools/:id` | Get tool details |
| `PATCH` | `/api/tools/:id` | Enable/disable tool |
| `GET` | `/api/registry/search` | Search registry |
| `POST` | `/api/registry/install` | Install from registry |
| `DELETE` | `/api/registry/skill/:id` | Uninstall registry entry |
| `GET` | `/api/registry/updates` | Check for updates |

---

## Architecture

```
~/.chvor/skills/*.md          User skills (hot-reloaded)
~/.chvor/tools/*.md           User tools (hot-reloaded)
data/bundled-skills/*.md      Built-in skills
data/bundled-tools/*.md       Built-in tools
lib/capability-loader.ts      Parses and loads all capabilities
lib/capability-parser.ts      Markdown + YAML frontmatter parser
lib/tool-builder.ts           Converts tools to LLM function definitions
lib/mcp-manager.ts            Spawns and manages MCP server processes
```
