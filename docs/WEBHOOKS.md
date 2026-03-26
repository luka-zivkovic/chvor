# Webhooks

Subscribe to external events from GitHub, Notion, Gmail, or any generic webhook source. When an event arrives, the AI processes it using a prompt template and optionally delivers results to a connected channel (Telegram, Discord, Slack).

## How It Works

```
External Service ──POST──▶ /api/webhooks/:id/receive
                                │
                          Signature verification
                                │
                          Parse payload (source-specific)
                                │
                          Check filters (event types, branches)
                                │
                          Render prompt template with event data
                                │
                          AI processes the prompt (orchestrator)
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
            Record event in DB        Deliver to channel(s)
```

1. **Create a subscription** — via the UI panel or by asking the AI in chat
2. **Configure the external service** — paste the webhook URL and secret into GitHub/Notion/etc.
3. **Receive events** — the server verifies signatures, parses the payload, and runs it through the AI
4. **Get results** — AI response appears in event history and optionally gets delivered to a channel

## Creating Webhooks

### Via Chat (AI Tools)

Ask the AI naturally:

> "Create a webhook for GitHub push events on my repo. Filter to only the main branch. Send results to my Telegram."

> "Set up a Notion webhook that summarizes page updates."

> "Subscribe to generic webhooks from my CI pipeline."

The AI uses the `native__create_webhook` tool and returns the webhook URL + secret.

### Via the UI

1. Open the **Webhooks** panel from the canvas (click the Webhooks hub node)
2. Click **+ New Webhook**
3. Fill in name, source, and prompt template
4. Copy the generated URL and secret into your external service

## Supported Sources

### GitHub

- **Signature**: HMAC-SHA256 via `X-Hub-Signature-256` header (automatic)
- **Parsed events**: `pull_request`, `issues`, `push`, `workflow_run`, and all other GitHub events
- **Template variables**: `{{event.details.repo}}`, `{{event.details.sender}}`, `{{event.details.title}}`, `{{event.details.number}}`, `{{event.details.branch}}`, `{{event.details.body}}`

**Setup**: In your GitHub repo, go to Settings > Webhooks > Add webhook. Paste the webhook URL and secret. Select content type `application/json`.

### Notion

- **Signature**: URL verification challenge handled automatically. Signature verification is a TODO (Notion doesn't yet provide standard HMAC headers).
- **Parsed events**: Automation webhook payloads, page property changes
- **Template variables**: `{{event.details.title}}`, `{{event.details.data}}`

### Gmail (Google Pub/Sub)

- **Signature**: JWT verification is a TODO (requires `google-auth-library`)
- **Parsed events**: New mail notifications with `emailAddress` and `historyId`
- **Template variables**: `{{event.details.emailAddress}}`, `{{event.details.historyId}}`

### Generic

- **Signature**: HMAC-SHA256 via `X-Webhook-Signature-256` header
- **Parsed events**: Reads `x-event-type` header or `event`/`type` field from body
- **Template variables**: `{{event.type}}`, `{{event.summary}}`, `{{payload}}`

**Signing your request** (example with curl):

```bash
SECRET="your-webhook-secret"
BODY='{"event":"deploy.success","details":"v1.2.3 deployed"}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

curl -X POST https://your-server/api/webhooks/<id>/receive \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature-256: $SIG" \
  -d "$BODY"
```

## Prompt Templates

Templates use `{{placeholder}}` syntax. Available variables:

| Variable | Description |
|----------|-------------|
| `{{event.type}}` | Event type (e.g. `push`, `pull_request.opened`) |
| `{{event.summary}}` | One-line summary of the event |
| `{{event.details.*}}` | Source-specific parsed fields (see above) |
| `{{payload}}` | Raw JSON payload (truncated to 4KB) |

**Example template:**

```
A new pull request was opened:

PR: {{event.details.title}} (#{{event.details.number}})
Author: {{event.details.sender}}
Branch: {{event.details.branch}}
Description: {{event.details.body}}

Please review the PR description and suggest any improvements. Flag potential issues.
```

## Filters

Optionally filter which events get processed:

- **Event types**: `["push", "pull_request.opened"]` — only process matching events
- **Branches**: `["main", "release/*"]` — only process events from matching branches

Events that don't match filters return `200 { "status": "filtered" }` without AI processing.

## Delivery

By default, AI results are stored in event history (visible in the Webhooks panel). Optionally deliver to a connected channel:

- **Telegram** — sends the AI response as a message
- **Discord** — sends to a configured Discord channel
- **Slack** — sends to a configured Slack channel

Configure delivery when creating the webhook via the `deliverTo` field or by asking the AI: *"...and send results to my Telegram"*.

## Rate Limiting

Each subscription is limited to **10 events per minute**. Events exceeding the limit are recorded with a "Rate limited" error and return `200` to the sender. This prevents runaway webhook storms from consuming AI resources.

## Health Monitoring

The pulse engine automatically monitors webhook health:

- **Stale webhooks**: Enabled webhooks with no events in 24+ hours are flagged
- **High-failure webhooks**: Webhooks where >50% of recent events have errors are flagged

These appear in the pulse health report alongside schedule and system health.

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/webhooks` | List all subscriptions |
| `GET` | `/api/webhooks/:id` | Get subscription details |
| `POST` | `/api/webhooks` | Create subscription |
| `PATCH` | `/api/webhooks/:id` | Update subscription |
| `DELETE` | `/api/webhooks/:id` | Delete subscription |
| `GET` | `/api/webhooks/:id/events` | List recent events |
| `POST` | `/api/webhooks/:id/receive` | Receiver endpoint (no auth — uses signature verification) |

## Architecture

```
routes/webhooks.ts          ← HTTP routes (CRUD + receiver)
lib/webhook-parsers.ts      ← Source-specific payload parsing + signature verification
lib/webhook-executor.ts     ← AI execution + channel delivery + rate limiting
db/webhook-store.ts         ← SQLite persistence (subscriptions + events)
lib/native-tools.ts         ← AI tools (create/list/delete webhooks)
lib/pulse-engine.ts         ← Health monitoring integration
```

Database tables (migration v10):
- `webhook_subscriptions` — subscription config, secret, filters, delivery targets
- `webhook_events` — event log with results/errors (auto-pruned to last 100 per subscription)
