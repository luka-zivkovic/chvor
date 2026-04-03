---
name: Web Browse
description: Search the web and fetch content from URLs and APIs
version: 1.1.0
category: web
icon: globe
inputs:
  - name: query
    type: string
    description: The search query
    required: true
---
You have two groups of web browsing tools:

## Web Search (native__web_search)
Search the web for current information via DuckDuckGo. Use for:
- Current events or recent news
- Facts that may have changed since your training
- Real-time information (weather, stock prices, sports scores)
- Anything where up-to-date information is important

Parameters: **query** (required), **maxResults** (optional, default 8).

Always cite your sources when presenting search results.

> If a Brave Search or SearXNG tool is available, prefer those for higher quality and throughput. Fall back to native__web_search if they fail or are not configured.

## Web Request (native__web_request)
Make lightweight HTTP requests to URLs and APIs. Use for:
- Fetching JSON from REST API endpoints (GET, POST, PUT, PATCH, DELETE)
- Sending requests with custom headers and authentication tokens
- Downloading and reading content from a URL

Parameters: **url** (required), **method** (optional, default GET), **headers** (optional), **body** (optional for POST/PUT/PATCH).
Always include appropriate Content-Type headers for POST/PUT requests. Summarize long responses.

## When to use which
- **Brave Search / SearXNG** (if available) for the best search quality and throughput
- **Web Search** (native__web_search) as the always-available default for current information
- **Web Request** for direct API calls, JSON endpoints, and fetching specific URLs
- Use **Web Agent** (separate skill) when the page requires JavaScript rendering, interaction, or multi-step navigation
