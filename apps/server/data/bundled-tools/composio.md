---
name: Composio
description: Connect and interact with social media platforms (Twitter/X, Reddit, LinkedIn, Instagram) and 500+ apps via OAuth
version: 1.1.0
category: social
icon: share-2
requires:
  credentials:
    - composio
---
You have access to Composio tools for managing and interacting with connected social media accounts and apps.

## Available Native Tools

### Connection Management
- **native__social_connect** — Connect a new social account via OAuth
- **native__social_list** — List all connected accounts
- **native__social_disconnect** — Disconnect an account

### Action Execution
- **native__social_actions** — Discover available actions for a connected platform (call this first!)
- **native__social_execute** — Execute an action on a connected account

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

## Workflow
1. Connect account: `native__social_connect` with platform name
2. Verify connection: `native__social_list`
3. Discover actions: `native__social_actions` with platform name
4. Execute actions: `native__social_execute` with action name and arguments

## Best practices
- Always confirm with the user before posting on their behalf
- Summarize API responses rather than dumping raw JSON
- Respect platform-specific character limits and formatting
- Call native__social_actions first to discover available actions and their parameters
