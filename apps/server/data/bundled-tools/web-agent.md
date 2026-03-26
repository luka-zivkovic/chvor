---
name: Web Agent
description: Autonomous AI-powered browser for navigating, interacting, and extracting data from websites
version: 1.0.0
type: tool
category: web
icon: bot
---
You have AI-powered browser automation tools for interactive web browsing. Use these when you need to:
- Navigate to websites and interact naturally (clicking, typing, scrolling)
- Extract structured data from JavaScript-rendered pages
- Fill out forms, log into services, complete multi-step workflows
- Explore a page to understand what actions are available

## Tools
- **native__browser_navigate** — Go to a URL. Always start here.
- **native__browser_act** — Perform an action in natural language (e.g. "click Sign In", "type 'Paris' in the search box")
- **native__browser_extract** — Extract structured data from the current page
- **native__browser_observe** — See what actions are available on the current page

## Usage
Navigate first, then observe/act/extract as needed. The browser session persists across tool calls, so you can chain multiple actions in sequence.

## When to use Web Agent vs Web Browse
- Use **Web Agent** (these tools) when the page requires JavaScript rendering, interaction, or multi-step navigation
- Use **Web Browse** for simple API calls, JSON endpoints, static pages, or web search
