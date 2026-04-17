---
name: SearXNG
description: Privacy-respecting web search via your self-hosted SearXNG instance (unlimited, free)
version: 1.0.0
author: chvor
type: tool
category: web
icon: search
tags:
  - search
  - web
  - searxng
  - self-hosted
  - privacy
  - mcp
mcp:
  command: npx
  args: ["-y", "mcp-searxng"]
  transport: stdio
  env:
    SEARXNG_URL: "{{credentials.searxng}}"
requires:
  credentials:
    - searxng
credentials:
  type: searxng
  name: SearXNG
  fields:
    - key: apiKey
      label: Instance URL
      required: true
      secret: false
      helpText: "Your self-hosted SearXNG instance URL (e.g. http://localhost:8080)"
---
Search the web using your self-hosted SearXNG instance. SearXNG is a free, privacy-respecting meta search engine that aggregates results from multiple sources.

## When to use
- **Prefer this tool** over native__web_search whenever it is available
- Unlimited searches with no rate limits (self-hosted)
- Privacy-respecting — no tracking or data collection
- Aggregates results from Google, Bing, DuckDuckGo, and many other engines

## Setup
1. Self-host SearXNG: `docker run -d -p 8080:8080 searxng/searxng`
2. Add your instance URL (e.g. `http://localhost:8080`) as a `searxng` credential in Chvor

Always cite your sources when presenting search results.
