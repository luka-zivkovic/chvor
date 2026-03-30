---
name: Composio
description: Connect and manage social media accounts and 500+ apps via OAuth with Composio
version: 1.2.0
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
requires:
  credentials:
    - composio
---
You have access to Composio tools for managing and interacting with connected social media accounts and apps.

## Available Native Tools

### Connection Management
- **native__social_connect** -- Connect a new social account via OAuth
- **native__social_list** -- List all connected accounts
- **native__social_disconnect** -- Disconnect an account

### Action Execution
- **native__social_actions** -- Discover available actions for a connected platform (call this first!)
- **native__social_execute** -- Execute an action on a connected account

## Supported Platforms

Twitter/X, Reddit, LinkedIn, Instagram, YouTube, TikTok, Discord, Telegram, Facebook, Bluesky, Mastodon, Pinterest, Threads -- and 500+ more via OAuth.

## Workflow

1. **Connect**: `native__social_connect` with the platform name
2. **Verify**: `native__social_list` to confirm the connection
3. **Discover**: `native__social_actions` to see available actions and their parameters
4. **Execute**: `native__social_execute` with the action name and arguments

## Error handling

- **OAuth failure**: Ask the user to retry `native__social_connect`. The OAuth token may have expired.
- **Action failure**: Re-check available actions with `native__social_actions` -- the action name or parameters may have changed.
- **Rate limits**: Some platforms throttle API calls. If you get rate-limited, wait before retrying and inform the user.

## Best practices

- Always confirm with the user before posting on their behalf
- Call `native__social_actions` first to discover available actions and their exact parameters
- Summarize API responses rather than dumping raw JSON
- Respect platform-specific character limits and formatting rules
- Not all platforms have the same capabilities -- check before assuming
