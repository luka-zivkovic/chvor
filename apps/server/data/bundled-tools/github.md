---
name: GitHub
description: Search code, manage issues and pull requests, and browse repositories via GitHub MCP
version: 1.2.0
author: chvor
type: tool
category: developer
icon: github
tags:
  - github
  - git
  - repositories
  - issues
  - pull-requests
  - code-search
  - mcp
  - version-control
  - source-code
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

## Available MCP Tools

Key tools (call with the MCP tool interface):
- **search_repositories** -- Find repos by keyword, language, or topic
- **get_file_contents** -- Read a file or directory listing from a repo
- **search_code** -- Search code across repositories
- **create_issue** -- Open a new issue with title, body, labels, assignees
- **list_issues** -- List and filter issues for a repo
- **create_pull_request** -- Open a new PR with title, body, head/base branches
- **list_commits** -- View commit history with messages and diffs
- **create_or_update_file** -- Create or update a file in a repo

## Common workflows

- **Browse a repo**: `search_repositories` -> `get_file_contents` (README, then specific files)
- **Investigate an issue**: `list_issues` -> read issue body -> `search_code` for related code
- **Code search**: `search_code` with query like `"function handleAuth" language:typescript`

## Authentication

The MCP server uses the `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable. If operations fail:
- The token may have expired -- ask the user to refresh their GitHub credential
- The token may lack required scopes (e.g., `repo` for private repos, `write` for creating issues/PRs)

## Best practices

- When showing code, include the file path and relevant line numbers
- Summarize large results rather than dumping raw JSON
- Link to GitHub URLs when referencing issues, PRs, or files
- Be aware of API rate limits -- avoid rapid successive calls for large queries

## Limitations

- Cannot push code directly -- use Claude Code for multi-file changes
- Cannot manage GitHub Actions workflows or secrets
- Token scope determines which operations are available
