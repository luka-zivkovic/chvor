---
name: GitHub
description: Manage GitHub repositories, issues, pull requests, and code search
version: 1.0.0
category: developer
icon: github
mcp:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-github"]
  transport: stdio
  env:
    GITHUB_PERSONAL_ACCESS_TOKEN: "{{credentials.github}}"
requires:
  credentials:
    - github
---
You have access to GitHub tools via MCP.

## Capabilities
- **Search repositories** — find repos by keyword, language, or topic
- **Browse code** — read files, directory structures, and file contents
- **Issues** — create, update, search, and comment on issues
- **Pull requests** — list, create, review, and manage PRs
- **Commits** — view commit history and diffs

## Environment
The GitHub MCP server uses the `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable for authentication.

## Best practices
- When showing code, include the file path and relevant line numbers
- Summarize large results rather than dumping raw JSON
- Link to GitHub URLs when referencing issues, PRs, or files
