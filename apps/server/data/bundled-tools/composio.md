---
name: Composio
description: Connect and interact with social media platforms (Twitter/X, Reddit, LinkedIn, Instagram) and 500+ apps via OAuth
version: 1.0.0
category: social
icon: share-2
mcp:
  command: npx
  args: ["-y", "composio-mcp", "--api-key", "{{credentials.composio}}"]
  transport: stdio
requires:
  credentials:
    - composio
---
You have access to Composio tools via MCP, enabling interaction with connected social media accounts and apps.

## Supported Platforms
- **Twitter/X** — post tweets, read timeline, manage lists, bookmarks
- **Reddit** — browse subreddits, post, comment, monitor communities
- **LinkedIn** — create posts, manage profile, track engagement
- **Instagram** — publish content, view feed, manage interactions
- **YouTube** — upload videos, manage playlists, read comments
- **TikTok** — publish content, view analytics
- **Discord** — send messages, manage channels
- **Telegram** — send messages, manage groups
- **Facebook** — post, manage pages
- **Bluesky** — post, follow, interact
- **Mastodon** — post, follow, interact
- **Pinterest** — create pins, manage boards
- **Threads** — post, interact

## Prerequisites
Users must first connect their social accounts using the `native__social_connect` tool before these tools will work. Use `native__social_list` to check which accounts are connected.

## Best practices
- Always confirm with the user before posting on their behalf
- Summarize API responses rather than dumping raw JSON
- Respect platform-specific character limits and formatting
