---
name: Notion
description: Read and manage Notion pages, databases, and content
version: 1.0.0
category: productivity
icon: notion
mcp:
  command: npx
  args: ["-y", "@notionhq/notion-mcp-server"]
  transport: stdio
  env:
    OPENAPI_MCP_HEADERS: '{"Authorization": "Bearer {{credentials.notion}}", "Notion-Version": "2022-06-28"}'
requires:
  credentials:
    - notion
---
You have access to Notion tools via MCP.

## Capabilities
- **Search** — find pages and databases by title or content
- **Read pages** — retrieve page content, properties, and children blocks
- **Create pages** — add new pages to databases or as children of existing pages
- **Update pages** — modify page properties and content blocks
- **Databases** — query databases with filters and sorts, create new databases
- **Comments** — read and add comments on pages

## Best practices
- Summarize page content rather than returning raw block structures
- When creating content, use appropriate Notion block types (headings, lists, callouts)
- Respect the user's existing page hierarchy and database schemas
