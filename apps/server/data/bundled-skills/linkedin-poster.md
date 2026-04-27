---
name: LinkedIn Poster
description: Create and publish LinkedIn posts with professional formatting and engagement optimization
version: 1.0.0
author: chvor
type: workflow
category: communication
icon: linkedin
defaultEnabled: false
requiredGroups:
  - social
  - web
tags:
  - linkedin
  - professional
  - networking
  - social-media
  - business
needs:
  - linkedin:post
  - social:connect
  - social:list
---
When the user asks to post to LinkedIn, share professional content, or create a LinkedIn update:

## First steps

1. Check if LinkedIn is connected via {{cap:social:list}}. If not, initiate {{cap:social:connect}} with platform "linkedin".
2. Use {{cap:linkedin:post}} to publish content.

## Post structure

LinkedIn's algorithm favors posts that keep people on-platform and drive comments. Structure every post with this in mind:

1. **Hook (first 2 lines)**: This is the "see more" bait. These lines appear before the fold -- they must compel the reader to click. Use a bold statement, surprising insight, or relatable problem.
2. **Body (short paragraphs)**: 1-2 sentences per paragraph max. Use liberal line breaks -- dense paragraphs get skipped. Optimal total length is 1,300-2,000 characters.
3. **Closing (CTA)**: End with a question to drive comments ("What's been your experience?", "Do you agree?") or a clear call-to-action.

## Formatting rules

- **Character limit**: 3,000 characters. But 1,300-2,000 performs best.
- **No links in the post body**: LinkedIn suppresses reach on posts with external links. Instead, put the link in the **first comment** after publishing. Offer to do this after the post goes live.
- **Line breaks**: Use them generously. Single-sentence paragraphs are the norm on LinkedIn.
- **No unicode bold/italic hacks**: They look gimmicky and reduce accessibility (screen readers can't parse them).
- **Hashtags**: 3-5 at the very bottom of the post. Choose specific ones (#ProductManagement over #Business).
- **Emojis**: Use sparingly at line starts for visual scanning, not mid-sentence.
- **Tagging**: Only tag people/companies directly relevant. Don't tag-spam for reach.

## Post types and templates

| Type | Structure | Example hook |
|------|-----------|-------------|
| **Professional insight** | Observation + reasoning + takeaway | "After 5 years of building products, here's what I wish I knew on day 1:" |
| **Career story** | Situation + challenge + lesson | "I got rejected from 47 interviews before landing my dream role." |
| **Industry commentary** | News/trend + your take + question | "Everyone's talking about AI replacing developers. Here's what they're missing:" |
| **How I did X** | Problem + approach + results | "We cut our deployment time from 2 hours to 8 minutes. Here's how:" |
| **Contrarian take** | Common belief + why it's wrong + better approach | "Unpopular opinion: daily standups are destroying your team's productivity." |

## Post-publish flow

After successfully publishing:
1. Offer to post the link as a **first comment** (this is standard LinkedIn practice for sharing URLs without hurting reach)
2. If the user has other platforms connected, offer to adapt and cross-post the content

## Common mistakes

- **Links in the body**: The #1 mistake. LinkedIn tanks reach for posts with external URLs. Always use the first-comment strategy.
- **Wall of text**: If your post doesn't have line breaks every 1-2 sentences, it won't get read.
- **Weak hook**: If the first 2 lines don't compel a click on "see more", the post is dead. Never start with "I'm excited to announce..." -- it's the LinkedIn equivalent of a skip button.
- **Over-hashtagging**: More than 5 hashtags looks desperate. 3-5 targeted ones is the sweet spot.
- **Being too formal**: LinkedIn has shifted toward authentic, conversational content. Stiff corporate-speak underperforms.

## When NOT to use

- User wants to post to multiple platforms -- use the Social Posting skill for cross-posting
- User wants to schedule posts -- use the Social Content Scheduler skill
- User wants to manage connections or send DMs -- outside this workflow's scope
