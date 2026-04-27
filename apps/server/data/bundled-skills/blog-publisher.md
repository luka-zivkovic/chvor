---
name: Blog Publisher
description: Write, format, and publish blog posts to WordPress, Ghost, Medium, and other CMS platforms
version: 1.0.0
author: chvor
type: workflow
category: communication
icon: file-text
defaultEnabled: false
requiredGroups:
  - social
  - comms
  - web
  - knowledge
tags:
  - blog
  - wordpress
  - ghost
  - medium
  - publishing
  - content
  - writing
  - cms
needs:
  - social:list
  - social:connect
  - wordpress:create-post
---
When the user asks to write a blog post, publish an article, or push content to a CMS:

## First steps

1. **Clarify the brief**: Ask for topic, target audience, target platform (WordPress, Ghost, Medium, etc.), and desired tone if not provided.
2. **Check connection**: Call {{cap:social:list}} to verify the target CMS platform is connected. If not, initiate {{cap:social:connect}}.
3. **Find actions**: Use {{cap:wordpress:create-post}} for WordPress, or the equivalent tool for the target CMS platform.

## Writing workflow

1. **Draft the post** using this structure:
   - **Title**: Under 60 characters, clear and compelling
   - **Meta description**: Under 160 characters, summarizes the post for search results
   - **Introduction**: 2-3 sentences that hook the reader and preview what they'll learn
   - **Body**: 3-5 sections with H2 headings, each covering one key point
   - **Conclusion**: Summarize key takeaways and include a call-to-action

2. **Show the full draft** to the user for review. Include title, meta description, and the complete body.
3. **Iterate** based on feedback until the user approves.
4. **Format for the target platform** (see platform-specific rules below).
5. **Publish** using {{cap:wordpress:create-post}} or the equivalent CMS tool.
6. **Report the result**: Published URL, post ID, or error details.

## Platform-specific formatting

| Platform | Format | Key details |
|----------|--------|-------------|
| **WordPress** | HTML | Use proper heading tags (h2, h3), paragraph tags, image tags with alt text. Support categories and tags if the action accepts them. |
| **Ghost** | Markdown | Native markdown support. Use standard heading syntax, code blocks, and image references. Set excerpt field separately. |
| **Medium** | Clean markdown | No custom HTML. Use standard markdown. Medium handles formatting from markdown well. Keep it simple. |
| **Notion** | Block-based | If publishing to Notion, structure as blocks. Use headings, paragraphs, bullet lists, and code blocks. |

## SEO checklist

Before publishing, verify:
- [ ] Title is under 60 characters
- [ ] Meta description is under 160 characters and includes the primary keyword
- [ ] Post has at least one image (or suggest adding one)
- [ ] Headings use a logical hierarchy (H2 for sections, H3 for subsections)
- [ ] Post includes at least one internal or external link
- [ ] Content is scannable -- short paragraphs, bullet points where appropriate

## Post-publish flow

After successful publication:
1. Share the published URL with the user
2. **Offer social promotion**: Ask if they'd like to create social media posts promoting the article. If yes, hand off to the Social Posting skill with the article title, key points, and URL as source content.

## Common mistakes

- **No hook**: The introduction must answer "why should I keep reading?" within the first 2 sentences.
- **Wall of text**: If any section exceeds 3-4 paragraphs without a subheading or visual break, split it up.
- **Generic title**: "How to Use X" is weak. "How to Use X to Solve Y in Z Minutes" is specific and compelling.
- **Forgetting meta description**: If the CMS supports it, always set it. It directly affects search click-through rates.
- **Publishing without preview**: Always show the full draft and get explicit approval before publishing.

## When NOT to use

- User wants to edit an already-published post -- check available tools for update/edit actions
- User wants pure writing help without publishing -- use the Writing Helper skill instead
- User wants to schedule blog posts for future dates -- use the Social Content Scheduler skill
