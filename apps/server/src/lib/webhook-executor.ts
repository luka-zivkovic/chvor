import type { ChatMessage, ExecutionEvent, WebhookSubscription, ParsedWebhookEvent, WebhookFilter } from "@chvor/shared";
import type { WSManager } from "../gateway/ws.ts";
import type { ChannelSender } from "./scheduler.ts";
import { recordWebhookEvent, countRecentWebhookEvents } from "../db/webhook-store.ts";
import { executeConversation } from "./orchestrator.ts";
import { insertActivity } from "../db/activity-store.ts";
import { logError } from "./error-logger.ts";
import { renderTemplate } from "./webhook-parsers.ts";

const WEBHOOK_EXCLUDED_TOOLS = [
  "native__create_webhook",
  "native__delete_webhook",
  "native__list_webhooks",
  "native__create_schedule",
  "native__delete_schedule",
  "native__list_schedules",
  "native__shell_execute",
  "native__pc_do",
  "native__pc_observe",
  "native__pc_shell",
  "native__claude_code",
  "native__add_credential",
  "native__update_credential",
  "native__delete_credential",
];

let wsManager: WSManager | null = null;
let channelSender: ChannelSender | null = null;

export function initWebhookExecutor(ws: WSManager, sender?: ChannelSender): void {
  wsManager = ws;
  channelSender = sender ?? null;
  console.log("[webhooks] executor initialized");
}

export function matchesFilters(
  parsed: ParsedWebhookEvent,
  filters: WebhookFilter | null
): boolean {
  if (!filters) return true;

  if (filters.eventTypes && filters.eventTypes.length > 0) {
    const match = filters.eventTypes.some(
      (et) => parsed.eventType === et || parsed.eventType.startsWith(et + ".")
    );
    if (!match) return false;
  }

  if (filters.branches && filters.branches.length > 0) {
    const branch = parsed.details.branch as string | undefined;
    // If a branch filter is set but the event has no branch, reject it
    if (!branch || !filters.branches.includes(branch)) return false;
  }

  return true;
}

// Simple per-subscription rate limiting
const rateLimits = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60_000;
let lastPruneTime = Date.now();

function pruneRateLimits(now: number): void {
  for (const [id, ts] of rateLimits) {
    const active = ts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (active.length === 0) {
      rateLimits.delete(id);
    } else {
      rateLimits.set(id, active);
    }
  }
  lastPruneTime = now;
}

function checkRateLimit(subscriptionId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimits.get(subscriptionId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;

  // DB-backed fallback: survives server restarts
  try {
    const dbCount = countRecentWebhookEvents(subscriptionId, RATE_LIMIT_WINDOW_MS);
    if (dbCount >= RATE_LIMIT_MAX) return false;
  } catch (err) {
    console.warn(`[webhooks] DB rate-limit check failed for ${subscriptionId}, using in-memory only:`, err);
  }

  recent.push(now);
  rateLimits.set(subscriptionId, recent);

  // Prune stale entries periodically to prevent unbounded growth
  if (now - lastPruneTime > RATE_LIMIT_PRUNE_INTERVAL_MS) {
    pruneRateLimits(now);
  }

  return true;
}

export async function executeWebhook(
  subscription: WebhookSubscription,
  parsed: ParsedWebhookEvent
): Promise<void> {
  if (!checkRateLimit(subscription.id)) {
    console.warn(`[webhooks] rate limited: "${subscription.name}" (${subscription.id})`);
    recordWebhookEvent(subscription.id, parsed.eventType, parsed.summary, null, "Rate limited");
    return;
  }

  console.log(`[webhooks] executing "${subscription.name}" for event: ${parsed.eventType}`);

  const renderedPrompt = renderTemplate(subscription.promptTemplate, parsed);

  const messages: ChatMessage[] = [
    {
      id: `webhook-${subscription.id}-${Date.now()}`,
      role: "user",
      content: `[WEBHOOK EVENT — This was triggered by an incoming webhook from ${subscription.source}. Process the event as instructed.]\n\n${renderedPrompt}`,
      channelType: "webhook",
      timestamp: new Date().toISOString(),
    },
  ];

  const emit = (event: ExecutionEvent): void => {
    wsManager?.broadcast({ type: "execution.event", data: event });
  };

  emit({ type: "execution.started", data: { executionId: `webhook-${subscription.id}` } });

  let result: string | null = null;
  let error: string | null = null;

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 3_000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const convResult = await executeConversation(messages, emit, undefined, undefined, {
        excludeTools: WEBHOOK_EXCLUDED_TOOLS,
        channelType: "webhook",
        sessionId: `webhook-${subscription.id}`,
      });
      result = convResult.text;
      error = null;
      emit({ type: "execution.completed", data: { output: result } });
      break;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS - 1) {
        console.warn(`[webhooks] "${subscription.name}" attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms:`, error);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(`[webhooks] "${subscription.name}" failed after ${attempt + 1} attempt(s):`, error);
        logError("webhook_error", err, { webhookId: subscription.id, webhookName: subscription.name });
        emit({ type: "execution.failed", data: { error } });
      }
    }
  }

  // Record event and deliver — wrapped so a DB/delivery failure doesn't lose the execution result
  try {
    recordWebhookEvent(subscription.id, parsed.eventType, parsed.summary, result, error);
  } catch (recordErr) {
    console.error(`[webhooks] failed to record event for "${subscription.name}":`, recordErr);
  }

  try {
    const activityEntry = insertActivity({
      source: "webhook",
      title: `Webhook: ${subscription.name}`,
      content: result || error || null,
    });
    wsManager?.broadcast({ type: "activity.new", data: activityEntry });
  } catch (activityErr) {
    console.error(`[webhooks] failed to record activity for "${subscription.name}":`, activityErr);
  }

  // Deliver to external channels if configured
  if (result && subscription.deliverTo && subscription.deliverTo.length > 0 && channelSender) {
    for (const target of subscription.deliverTo) {
      try {
        await channelSender(target.channelType, target.channelId, result);
        console.log(`[webhooks] delivered "${subscription.name}" → ${target.channelType}/${target.channelId}`);
      } catch (err) {
        console.error(`[webhooks] delivery to ${target.channelType}/${target.channelId} failed:`, err);
      }
    }
  }
}
