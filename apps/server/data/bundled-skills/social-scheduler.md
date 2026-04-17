---
name: Social Content Scheduler
description: Plan and schedule recurring social media posts using cron-based automation
version: 1.0.0
author: chvor
type: workflow
category: communication
icon: calendar
defaultEnabled: false
tags:
  - scheduling
  - social-media
  - content-calendar
  - automation
  - cron
  - recurring
needs:
  - social:list
  - social:connect
  - twitter:post
  - linkedin:post
---
When the user asks to schedule social media posts, set up recurring content, or create a content calendar:

## How it works

This skill combines `native__create_schedule` (cron-based task scheduling) with your available social posting tools. A schedule runs a prompt at the specified time, and that prompt instructs the AI to generate and post content automatically.

## First steps

1. **Verify connections**: Call {{cap:social:list}} to confirm the target platforms are connected.
2. **Clarify the content plan**: Ask what kind of recurring content they want, which platform(s), and how often.
3. **Choose a schedule pattern** from the presets below or create a custom one.

## Schedule pattern presets

| Pattern | Cron expression | Description |
|---------|----------------|-------------|
| **Daily morning** | `0 9 * * *` | Every day at 9:00 AM |
| **Weekdays only** | `0 9 * * 1-5` | Monday through Friday at 9:00 AM |
| **Twice daily** | `0 9,17 * * *` | 9:00 AM and 5:00 PM daily |
| **Weekly Monday** | `0 10 * * 1` | Every Monday at 10:00 AM |
| **Twice a week** | `0 10 * * 1,4` | Monday and Thursday at 10:00 AM |
| **Monthly first** | `0 10 1 * *` | First day of each month at 10:00 AM |

Ask the user which pattern fits, or help them define a custom cron expression.

## Content calendar workflow

1. **Define the content type**: What will the recurring posts be about?
   - Daily tips or insights on a topic
   - Weekly roundups or summaries
   - Quote of the day
   - Product updates or announcements
   - Industry news commentary
   - Educational content series

2. **Build a self-contained prompt**: The scheduled prompt runs without the user present, so it must include ALL context needed to generate and post content. Use this template:

   > Generate a [content type] about [topic/niche]. The tone should be [tone]. Format it for [platform] following these rules: [platform-specific rules from the relevant poster skill]. Keep it under [character limit] characters. Then post it to my connected [platform] account.

3. **Set delivery targets** (optional): Use the `deliverTo` parameter to also send the generated content to a channel (Telegram, Discord, Slack) for visibility.

4. **Create the schedule**: Use `native__create_schedule` with the cron expression, prompt, and optional delivery targets.

## Safety recommendations

**Automated posting carries risk.** Always recommend these safeguards:

1. **Start with a dry run**: Create the schedule with `deliverTo` set to a private channel (Telegram, Discord) but WITHOUT the posting instruction in the prompt. This lets the user review generated content before it goes live.
2. **Graduate to auto-posting**: Once the user is confident in the content quality, update the prompt to include the posting step.
3. **Set a review cadence**: Suggest the user review scheduled output weekly to catch drift in tone or relevance.
4. **Use one-shot for testing**: Create a `oneShot: true` schedule to test the flow once before committing to a recurring schedule.

## Managing schedules

- **List schedules**: Use `native__list_schedules` to show all active and paused schedules
- **Delete a schedule**: Use `native__delete_schedule` with the schedule ID
- **Modify**: Delete the old schedule and create a new one with updated parameters (there's no edit-in-place)
- **Pause/resume**: Delete to pause, recreate to resume (suggest saving the prompt for easy recreation)

## Schedule prompt examples

**Daily LinkedIn tip:**
> Generate a concise professional tip about software engineering leadership. Format it for LinkedIn: hook in the first 2 lines, short paragraphs, 1300-2000 characters, end with an engaging question, 3-5 hashtags at the bottom. No external links in the body. Post it to my connected LinkedIn account.

**Weekly Twitter thread:**
> Generate a Twitter thread (4-6 tweets) about a trending topic in AI/ML. Tweet 1 must be a compelling hook. Each tweet under 280 characters. Post as a thread by chaining replies using the tweet ID from each response.

**Daily motivational quote:**
> Pick an inspiring quote from a notable figure in technology or science. Format it as a tweet: the quote in quotation marks, attributed to the author, with 1-2 relevant hashtags. Keep it under 280 characters. Post to my connected Twitter account.

## Common mistakes

- **Prompt too vague**: "Post something interesting" will produce inconsistent results. Be specific about topic, tone, length, and formatting.
- **Missing tool references**: The prompt should mention the target platform so the AI knows which posting tools to use.
- **No safety net**: Always start with dry-run delivery to a channel before enabling auto-posting.
- **Token expiration**: Long-running schedules may hit expired OAuth tokens. If a scheduled post fails, the error will appear in the schedule's `lastError`. The user may need to re-authorize via {{cap:social:connect}}.

## When NOT to use

- User wants to post right now -- use the Social Posting, Twitter/X Poster, or LinkedIn Poster skills
- User wants to schedule non-social tasks -- the general scheduling system (`native__create_schedule`) handles that directly
