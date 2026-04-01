---
name: Social Posting
description: Post content to social media platforms with cross-posting and platform-aware formatting
version: 1.0.0
author: chvor
type: workflow
category: communication
icon: share-2
tags:
  - social-media
  - cross-posting
  - twitter
  - linkedin
  - content
  - marketing
requires:
  credentials:
    - composio
---
When the user asks to post content to social media, share something on a platform, or cross-post across multiple platforms:

## First steps

1. **Check connections**: Call `native__social_list` to see which platforms are connected.
2. **Connect if needed**: If the target platform isn't connected, use `native__social_connect` to start the OAuth flow. Wait for the user to complete authorization before proceeding.
3. **Discover actions**: Always call `native__social_actions` for the target platform to get the exact action names and parameter schemas. Never hardcode action names -- they may change.

## Single-platform posting

1. Ask the user what they want to post (or use their provided content)
2. Adapt the content for the target platform using the formatting rules below
3. **Show a preview** of the formatted post and ask for confirmation
4. Only after explicit approval, call `native__social_execute` with the discovered action name and formatted content
5. Report the result (success, post URL if available, or error details)

## Cross-posting workflow

When the user wants to post to multiple platforms at once:

1. Take the source content and adapt it for **each** target platform independently
2. Show all adapted versions side-by-side in a single message for review
3. Ask the user to approve, edit, or skip specific platforms
4. Post to each approved platform sequentially, reporting results as you go
5. Provide a summary: which platforms succeeded, which failed, and any post URLs

## Platform formatting reference

| Platform | Max length | Hashtags | Links | Key rules |
|----------|-----------|----------|-------|-----------|
| **Twitter/X** | 280 chars | 2-3 max | Counted in limit | Hook in first line, no leading @ |
| **LinkedIn** | 3,000 chars | 3-5 at bottom | Put in first comment, not body | Hook in first 2 lines, short paragraphs |
| **Instagram** | 2,200 chars | Up to 30 | Not clickable in captions | Strong opening, emoji-friendly |
| **Facebook** | 63,206 chars | Minimal | Inline OK | Conversational, question-ending |
| **Reddit** | 40,000 chars | None | Inline OK | Match subreddit tone, no self-promo vibe |
| **Bluesky** | 300 chars | Minimal | Inline OK | Similar to Twitter, slightly longer |

## Error recovery

- If a post fails, show the error message clearly
- If the error suggests an expired token, offer to reconnect via `native__social_connect`
- If rate-limited, inform the user and suggest waiting or trying later
- Never retry automatically without asking

## Confirmation gate

**Never post content without showing a preview and getting explicit user approval.** This is non-negotiable. Social posts are public and permanent.

## When NOT to use

- User wants to write content from scratch without posting -- use the Writing Helper skill instead
- User wants analytics, follower management, or metrics -- Composio may support these but they're outside this workflow
- User wants to schedule recurring posts -- use the Social Content Scheduler skill instead
