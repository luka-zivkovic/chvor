---
name: Writing Helper
description: Edit and refine text for clarity, tone, and structure while preserving the author's voice
version: 1.2.0
author: chvor
type: workflow
defaultEnabled: false
requiredGroups:
  - knowledge
category: productivity
icon: pen
tags:
  - writing
  - editing
  - content
  - grammar
  - copywriting
  - proofreading
  - tone
  - style
  - revision
  - blog
  - email
  - documentation
---
When the user asks for help with writing, editing, or refining text:

## First steps

- **Ask first**: If they share text without specifying what they want, ask: "Would you like me to edit for clarity, shorten it, adjust the tone, improve structure, or something else?"
- **Preserve their voice**: Don't rewrite everything in a generic AI tone. Match their style and intent.

## Edit process

1. Read the full text before making any changes
2. Identify the biggest issue (usually structure or clarity, not grammar)
3. Provide specific edits using this format:
   - **Original**: the phrase or sentence
   - **Suggested**: your revision
   - **Why**: one sentence explaining the change
4. For structural issues, suggest reordering or breaking into sections before line-editing

## Content-type guidance

| Type | Focus | Tone |
|------|-------|------|
| **Email** | Concise, clear action items, scannable | Direct, professional |
| **Blog post** | Engaging hook, scannable headings, clear takeaway | Conversational, authoritative |
| **Documentation** | Precise, structured, complete | Neutral, technical |
| **Social media** | Punchy, platform-aware character limits | Casual, attention-grabbing |
| **Academic** | Formal, well-cited, logically structured | Objective, measured |

## Tone spectrum

When the user asks to adjust tone, think on this spectrum:
- **Formal** -> Academic, legal, executive communications
- **Professional** -> Business emails, reports, proposals
- **Conversational** -> Blog posts, newsletters, documentation
- **Casual** -> Social media, chat, internal team comms

## When NOT to use

- User wants a complete rewrite from scratch -- that's content generation, not editing
- User wants translation between languages
- User wants factual research added to their text

## Common mistakes

- **Over-editing**: Removing the author's personality and making everything sound like AI. Less is more.
- **Fixing grammar when structure is the problem**: If paragraphs are in the wrong order, fixing commas won't help.
- **Ignoring the audience**: A developer README and a marketing landing page need completely different edits.
- **Making everything shorter**: Conciseness is good, but some contexts (documentation, legal) need thoroughness.
