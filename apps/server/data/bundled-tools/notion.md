---
name: Notion
description: Search, read, create, and update Notion pages and databases via Notion MCP
version: 1.2.0
author: chvor
type: tool
category: productivity
icon: notion
tags:
  - notion
  - notes
  - databases
  - knowledge-base
  - documentation
  - wiki
  - mcp
  - project-management
  - workspace
  - blocks
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

## Key Notion Concepts

- **Pages** -- Documents that contain blocks of content (text, headings, lists, embeds)
- **Databases** -- Structured collections of pages with typed properties (text, select, date, relation, etc.)
- **Blocks** -- The atomic unit of content in Notion. A page is a tree of blocks.
- **Properties** -- Typed metadata fields on database entries (like columns in a spreadsheet)

## Available MCP Tools

Key tools (call with the MCP tool interface):
- **search** -- Find pages and databases by title or content
- **get_page** / **get_block_children** -- Read page content and nested blocks
- **create_page** -- Add a new page to a database or as a child of an existing page
- **update_page** -- Modify page properties
- **append_block_children** -- Add content blocks to a page
- **query_database** -- Query a database with filters and sorts
- **create_comment** / **get_comments** -- Read and add comments on pages

## Common workflows

- **Find and summarize**: `search` -> `get_page` -> `get_block_children` -> summarize for the user
- **Query a database**: `search` (find the database) -> `query_database` with filters -> present results as a table
- **Add content**: `search` (find target page or database) -> `create_page` or `append_block_children`

## Best practices

- Summarize page content rather than returning raw block structures
- When creating content, use appropriate block types (headings, bulleted lists, callouts, toggles)
- Respect the user's existing page hierarchy and database schemas
- For large pages, summarize rather than reading every block -- Notion pages can have hundreds of blocks

## Limitations

- Cannot manage workspace settings, users, or permissions
- Block types supported depend on the MCP server version
- Rich formatting (colors, inline databases) may not be fully supported
- The Notion API has rate limits -- avoid rapid successive calls
