# Browser Automation

Chvor can browse the web autonomously using a built-in browser powered by Stagehand (Playwright). The AI can navigate pages, click buttons, fill forms, and extract structured data.

---

## Quick Start

Ask the AI:

> "Go to github.com and check my notifications"

> "Search Google for 'best practices for Node.js error handling' and summarize the top results"

> "Fill in the contact form at example.com with my details"

---

## AI Tools

| Tool | Description | Example |
|------|-------------|---------|
| `native__browser_navigate` | Open a URL | "Go to https://github.com" |
| `native__browser_act` | Interact with the page | "Click the Sign In button", "Type 'hello' in the search box" |
| `native__browser_observe` | See available elements | "What buttons are on this page?" |
| `native__browser_extract` | Get structured data | "Extract all product names and prices as JSON" |

### Workflow

1. AI navigates to a page
2. AI observes available elements
3. AI acts (click, type, scroll)
4. AI extracts data or observes the result
5. Repeat as needed

---

## Web Agent vs Web Browse

Two ways to access the web:

| Feature | Web Agent (Browser) | Web Browse (HTTP) |
|---------|-------------------|-------------------|
| **How** | Full Chromium browser | Simple HTTP requests |
| **Best for** | JavaScript-heavy pages, forms, multi-step flows | APIs, static pages, search |
| **Tools** | `native__browser_*` | `native__web_request`, DuckDuckGo search |
| **Cost** | Higher (browser + vision LLM) | Lower (text only) |
| **Speed** | Slower (page rendering) | Faster (direct HTTP) |

The AI automatically chooses the right approach based on the task.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Headless mode | `true` | Run browser without visible window |
| Max concurrent sessions | 3 | Parallel browser instances |
| Inactivity timeout | 5 minutes | Auto-close unused sessions |

Set headless mode via environment variable:

```bash
CHVOR_BROWSER_HEADLESS=false  # Show browser window (useful for debugging)
```

---

## Security

- **SSRF protection**: URLs are validated against private IP ranges (127.*, 10.*, 172.16-31.*, 192.168.*, localhost, etc.)
- **Session isolation**: Each conversation gets its own browser session
- **Auto-cleanup**: Inactive sessions are closed after 5 minutes
- **Headless by default**: No visible window in production

---

## Requirements

- **Chromium**: Auto-installed via Playwright on first use (`npx playwright install chromium`)
- **Disk**: ~200MB for the Chromium binary
- **RAM**: ~100-300MB per active browser session
