---
name: Web Browse
description: Search the web and fetch content from URLs and APIs
version: 1.0.0
category: web
icon: globe
mcp:
  command: npx
  args: ["-y", "duckduckgo-mcp-server"]
  transport: stdio
inputs:
  - name: query
    type: string
    description: The search query
    required: true
---
You have two groups of web browsing tools:

## Web Request (native__web_request)
Make lightweight HTTP requests to URLs and APIs. Use for:
- Fetching JSON from REST API endpoints (GET, POST, PUT, PATCH, DELETE)
- Sending requests with custom headers and authentication tokens
- Downloading and reading content from a URL

Parameters: **url** (required), **method** (optional, default GET), **headers** (optional), **body** (optional for POST/PUT/PATCH).
Always include appropriate Content-Type headers for POST/PUT requests. Summarize long responses.

## Web Search (duckduckgo_search via MCP)
Search the web for current information via DuckDuckGo. Use for:
- Current events or recent news
- Facts that may have changed since your training
- Real-time information (weather, stock prices, sports scores)
- Anything where up-to-date information is important

Always cite your sources when presenting search results.

## When to use which
- **Web Request** for simple API calls, JSON endpoints, and static pages
- **Web Search** when the user needs current/up-to-date information from the internet
- Use **Web Agent** (separate skill) when the page requires JavaScript rendering, interaction, or multi-step navigation
