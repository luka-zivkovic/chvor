---
name: Context7
description: Look up real-time library documentation and code examples via Context7 MCP
version: 1.2.0
author: chvor
type: tool
category: developer
icon: context7
tags:
  - documentation
  - api-reference
  - libraries
  - code-examples
  - developer-tools
  - mcp
  - real-time
  - api-docs
  - npm
  - packages
mcp:
  command: npx
  args: ["-y", "@upstash/context7-mcp@latest"]
  transport: stdio
---
You have access to Context7 for real-time documentation lookup via MCP.

## Available MCP Tools

- **resolve-library-id** -- Find the correct Context7 library ID for a package or framework. Always call this first.
- **get-library-docs** -- Retrieve documentation, API references, and code examples for a resolved library.

## Workflow

1. Call `resolve-library-id` with the library name (e.g., "react", "next.js", "prisma")
2. Pick the correct match from the results (check name and description)
3. Call `get-library-docs` with the resolved ID and a specific query

## Query tips

- **Be specific**: "React useEffect cleanup function" not "React"
- **Include version context**: "Next.js 14 app router middleware" not "Next.js routing"
- **Target a concept**: "Prisma transactions nested writes" not "Prisma"

## When to use

- User asks about a library's API, usage patterns, or best practices
- You need current documentation (your training data may be outdated)
- Implementing features with third-party libraries and need accurate API signatures

## Best practices

- Always resolve the library ID first -- don't guess IDs
- Cite the documentation source when presenting information
- If results are sparse, try a broader or narrower query term
- If docs are insufficient, fall back to web search for additional context

## Limitations

- Not all libraries are indexed -- very new or niche packages may be missing
- Documentation may lag behind the latest release by days or weeks
- Results are read-only summaries -- always verify critical details against official docs
