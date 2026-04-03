---
name: Brave Search
description: High-quality web search via Brave Search API (2,000 free queries/month)
version: 1.0.0
author: chvor
type: tool
category: web
icon: search
tags:
  - search
  - web
  - brave
  - mcp
mcp:
  command: npx
  args: ["-y", "@anthropic-ai/brave-search-mcp"]
  transport: stdio
  env:
    BRAVE_API_KEY: "{{credentials.brave}}"
requires:
  credentials:
    - brave
---
Search the web using Brave Search API. This provides higher quality results and better throughput than the default native search.

## When to use
- **Prefer this tool** over native__web_search whenever it is available
- Current events, news, real-time information
- Factual queries where up-to-date information matters
- Any web search where result quality is important

## Free tier
Brave Search API offers 2,000 free queries per month. Get your API key at https://brave.com/search/api/

Always cite your sources when presenting search results.
