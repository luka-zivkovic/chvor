# Schedules

Create recurring tasks that the AI executes on a cron schedule. Use schedules for daily summaries, periodic checks, automated reports, or any repeating task.

---

## Quick Start

Ask the AI:

> "Every morning at 9am, check my GitHub notifications and summarize them"

> "Run a system health check every 6 hours"

Or use the Schedules panel in the sidebar.

---

## Creating Schedules

### Via Chat

The AI uses `native__create_schedule` when you describe a recurring task:

> "Remind me to review PRs every weekday at 2pm"

### Via UI

1. Open the **Schedules** panel from the sidebar
2. Click **+ New Schedule**
3. Set a name, cron expression, and prompt
4. Optionally link a workflow or set delivery targets

### Via API

```bash
curl -X POST http://localhost:3001/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Daily GitHub Summary",
    "cronExpression": "0 9 * * *",
    "prompt": "Check my GitHub notifications and give me a brief summary",
    "enabled": true
  }'
```

---

## Cron Expressions

Standard 5-field cron format:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 */6 * * *` | Every 6 hours |
| `0 0 1 * *` | First day of every month at midnight |

---

## Options

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name |
| `cronExpression` | string | When to run (cron syntax) |
| `prompt` | string | What to tell the AI |
| `enabled` | boolean | Active or paused |
| `oneShot` | boolean | Run once then auto-disable |
| `workflowId` | string | Link to a saved workflow instead of a prompt |
| `workflowParams` | object | Parameter overrides for the workflow |
| `deliverTo` | array | Send results to channels: `[{channelType, channelId, label}]` |

---

## Delivery

By default, schedule results appear in the Activity panel. Optionally deliver to a channel:

```json
{
  "deliverTo": [
    { "channelType": "telegram", "channelId": "123456789", "label": "My Telegram" }
  ]
}
```

The AI's response is sent to the specified channel after execution.

---

## Execution History

View past runs for any schedule:

```bash
curl http://localhost:3001/api/schedules/:id/runs
```

Each run records: status (success/failed), result text, error (if any), and timestamp.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/schedules` | List all schedules |
| `GET` | `/api/schedules/:id` | Get schedule details |
| `POST` | `/api/schedules` | Create schedule |
| `PATCH` | `/api/schedules/:id` | Update schedule |
| `DELETE` | `/api/schedules/:id` | Delete schedule |
| `GET` | `/api/schedules/:id/runs` | List execution history |
