---
name: Composio
description: Connect and manage social media accounts and 500+ apps via OAuth with Composio
version: 1.3.0
author: chvor
type: tool
category: communication
icon: share-2
tags:
  - social-media
  - twitter
  - reddit
  - linkedin
  - instagram
  - oauth
  - automation
  - social-posting
  - api-integration
mcp:
  transport: sse
  url: "https://mcp.composio.dev/{{credentials.composio}}"
requires:
  credentials:
    - composio
---
You have access to Composio tools for managing and interacting with connected social media accounts and apps.

## OAuth Connection Management (Native Tools)

- **native__social_connect** -- Connect a new social account via OAuth
- **native__social_list** -- List all connected accounts
- **native__social_disconnect** -- Disconnect an account

## Action Execution (Auto-Discovered MCP Tools)

Composio actions are automatically discovered and available as `composio__<ACTION_NAME>` tools.
These include actions for all connected platforms: posting, commenting, browsing feeds, managing profiles, etc.

## Supported Platforms

Twitter/X, Reddit, LinkedIn, Instagram, YouTube, TikTok, Discord, Telegram, Facebook, Bluesky, Mastodon, Pinterest, Threads -- and 500+ more via OAuth.

## Workflow

1. **Connect**: `native__social_connect` with the platform name
2. **Verify**: `native__social_list` to confirm the connection
3. **Execute**: Use the auto-discovered `composio__*` tools directly -- they are already available in your tool list

## Error handling

- **OAuth failure**: Ask the user to retry `native__social_connect`. The OAuth token may have expired.
- **MCP connection failure**: The MCP connection to Composio will auto-reconnect. If tools are missing, the credential may be invalid.
- **Rate limits**: Some platforms throttle API calls. If you get rate-limited, wait before retrying.

## Best practices

- Always confirm with the user before posting on their behalf
- Summarize API responses rather than dumping raw JSON
- Respect platform-specific character limits and formatting rules
- Not all platforms have the same capabilities -- check before assuming
