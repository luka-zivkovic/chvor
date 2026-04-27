---
name: Twitter/X Poster
description: Compose and publish tweets and threads on Twitter/X with proper formatting and thread management
version: 1.0.0
author: chvor
type: workflow
category: communication
icon: twitter
defaultEnabled: false
requiredGroups:
  - social
  - web
tags:
  - twitter
  - x
  - tweets
  - threads
  - social-media
needs:
  - twitter:post
  - twitter:reply
  - social:connect
  - social:list
---
When the user asks to post a tweet, create a thread, or share content on Twitter/X:

## First steps

1. Check if Twitter is connected via {{cap:social:list}}. If not, initiate {{cap:social:connect}} with platform "twitter".
2. Use the tools listed below to post and interact on Twitter.

## Single tweet

1. Compose within **280 characters**. Show the character count.
2. Add 2-3 relevant hashtags if appropriate (don't force them).
3. Show preview with character count and ask for confirmation.
4. Post using {{cap:twitter:post}}.
5. Report success and share the tweet URL if returned.

**Formatting rules:**
- Front-load the hook -- first words determine if people read on
- Never start with @ (limits visibility to mutual followers only)
- Use line breaks for readability instead of wall-of-text
- Hashtags at the end, not inline (unless they flow naturally)
- Max 2-3 hashtags -- more looks spammy
- Links count toward the 280 character limit (t.co wraps to ~23 chars)

## Thread posting

When content exceeds 280 characters or the user explicitly asks for a thread:

1. **Break into chunks**: Split the content into tweet-sized pieces (under 280 chars each). Each tweet should be a complete thought.
2. **Craft the hook**: Tweet 1 is everything -- it determines if anyone reads the rest. Make it compelling, provocative, or promise clear value.
3. **Number the tweets**: Show as "1/N", "2/N", etc. in the preview for clarity (but don't include numbering in the actual tweets unless the user wants it).
4. **Preview all tweets** at once and get approval before posting any.
5. **Post sequentially**:
   - Post tweet 1 using {{cap:twitter:post}}
   - Extract the tweet ID from the response
   - Post tweet 2 as a reply to tweet 1 using {{cap:twitter:reply}} (pass the tweet ID as the `in_reply_to` or reply parameter)
   - Continue chaining each subsequent tweet as a reply to the previous one
   - Report progress after each tweet
6. **Handle failures**: If a tweet in the middle of a thread fails, stop and report which tweets were posted and which weren't. Don't leave orphaned partial threads without telling the user.

## Thread structure tips

| Position | Purpose | Advice |
|----------|---------|--------|
| **Tweet 1** | Hook | Bold claim, surprising stat, or clear promise of value |
| **Middle tweets** | Substance | One idea per tweet, build on each other logically |
| **Last tweet** | CTA | Summarize, ask for retweet, link to full content, or ask a question |

## Content patterns

- **Hot take**: Strong opinion + reasoning in 1-2 tweets
- **Listicle thread**: "10 things I learned about X" -- one item per tweet
- **Story thread**: Narrative arc -- setup, tension, resolution
- **How-to thread**: Step-by-step instructions, one step per tweet
- **Announcement**: News + context + link

## Common mistakes

- **No hook**: If tweet 1 doesn't grab attention, the thread dies. Never start with "Thread:" or "1/".
- **Overstuffing**: Don't use all 280 characters in every tweet. White space and shorter tweets feel more natural.
- **Hashtag spam**: More than 3 hashtags makes you look like a bot.
- **Thread for a single thought**: If it fits in one tweet, don't make it a thread. Threads earn attention -- don't waste it.

## When NOT to use

- User wants to post to multiple platforms -- use the Social Posting skill for cross-posting
- User wants to schedule tweets -- use the Social Content Scheduler skill
- User wants to read their timeline or check mentions -- outside this workflow's scope
