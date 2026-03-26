---
name: Context7
description: Look up library documentation and code examples in real-time
version: 1.0.0
category: developer
icon: context7
mcp:
  command: npx
  args: ["-y", "@upstash/context7-mcp@latest"]
  transport: stdio
---
You have access to Context7 for real-time documentation lookup.

## Capabilities
- **Resolve library** — find the correct library ID for any package or framework
- **Query docs** — retrieve up-to-date documentation, API references, and code examples

## When to use
- When the user asks about a library's API or usage patterns
- When you need current documentation (your training data may be outdated)
- When implementing features with third-party libraries

## Best practices
- Always resolve the library ID first before querying docs
- Use specific queries (e.g., "React useEffect cleanup" instead of just "React")
- Cite the documentation source when presenting information
- If docs are insufficient, combine with web search for additional context
