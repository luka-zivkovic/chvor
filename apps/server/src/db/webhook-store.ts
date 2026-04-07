import { randomUUID, randomBytes } from "node:crypto";
import type {
  WebhookSubscription,
  WebhookEvent,
  WebhookFilter,
  CreateWebhookRequest,
  UpdateWebhookRequest,
  DeliveryTarget,
} from "@chvor/shared";
import { getDb } from "./database.ts";

interface WebhookSubscriptionRow {
  id: string;
  name: string;
  source: string;
  secret: string;
  prompt_template: string;
  workspace_id: string;
  enabled: number;
  deliver_to: string | null;
  filters: string | null;
  last_received_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSubscription(row: WebhookSubscriptionRow): WebhookSubscription {
  return {
    id: row.id,
    name: row.name,
    source: row.source as WebhookSubscription["source"],
    secret: row.secret,
    promptTemplate: row.prompt_template,
    workspaceId: row.workspace_id,
    enabled: row.enabled === 1,
    deliverTo: row.deliver_to
      ? (() => { try { return JSON.parse(row.deliver_to!) as DeliveryTarget[]; } catch { return null; } })()
      : null,
    filters: row.filters
      ? (() => { try { return JSON.parse(row.filters!) as WebhookFilter; } catch { return null; } })()
      : null,
    lastReceivedAt: row.last_received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWebhookSubscriptions(): WebhookSubscription[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM webhook_subscriptions ORDER BY created_at DESC")
    .all() as WebhookSubscriptionRow[];
  return rows.map(rowToSubscription);
}

export function getWebhookSubscription(id: string): WebhookSubscription | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as WebhookSubscriptionRow | undefined;
  return row ? rowToSubscription(row) : null;
}

export function createWebhookSubscription(req: CreateWebhookRequest): WebhookSubscription {
  const db = getDb();
  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const deliverTo = req.deliverTo ? JSON.stringify(req.deliverTo) : null;
  const filters = req.filters ? JSON.stringify(req.filters) : null;
  const workspaceId = req.workspaceId ?? "default-constellation";

  db.prepare(
    `INSERT INTO webhook_subscriptions (id, name, source, secret, prompt_template, workspace_id, enabled, deliver_to, filters, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(id, req.name, req.source, secret, req.promptTemplate, workspaceId, deliverTo, filters, now, now);

  const created = getWebhookSubscription(id);
  if (!created) throw new Error(`Failed to create webhook subscription "${req.name}" — insert succeeded but read-back returned null`);
  return created;
}

export function updateWebhookSubscription(
  id: string,
  updates: UpdateWebhookRequest
): WebhookSubscription | null {
  const existing = getWebhookSubscription(id);
  if (!existing) return null;

  const db = getDb();
  const now = new Date().toISOString();
  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.promptTemplate !== undefined) {
    fields.push("prompt_template = ?");
    values.push(updates.promptTemplate);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.deliverTo !== undefined) {
    fields.push("deliver_to = ?");
    values.push(updates.deliverTo ? JSON.stringify(updates.deliverTo) : null);
  }
  if (updates.filters !== undefined) {
    fields.push("filters = ?");
    values.push(updates.filters ? JSON.stringify(updates.filters) : null);
  }

  values.push(id);
  db.prepare(`UPDATE webhook_subscriptions SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values
  );
  const updated = getWebhookSubscription(id);
  if (!updated) throw new Error(`Failed to update webhook subscription "${id}" — update succeeded but read-back returned null`);
  return updated;
}

export function deleteWebhookSubscription(id: string): boolean {
  const db = getDb();
  let deleted = false;
  const deleteTx = db.transaction(() => {
    db.prepare("DELETE FROM webhook_events WHERE subscription_id = ?").run(id);
    const result = db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id);
    deleted = result.changes > 0;
  });
  deleteTx();
  return deleted;
}

export function recordWebhookEvent(
  subscriptionId: string,
  eventType: string,
  payloadSummary: string | null,
  result: string | null,
  error: string | null
): WebhookEvent {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const truncatedResult = result ? result.slice(0, 2000) : null;
  const truncatedSummary = payloadSummary ? payloadSummary.slice(0, 1000) : null;

  const recordTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO webhook_events (id, subscription_id, event_type, payload_summary, result, error, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, subscriptionId, eventType, truncatedSummary, truncatedResult, error, now);

    // Update last_received_at on the subscription
    db.prepare(
      `UPDATE webhook_subscriptions SET last_received_at = ?, updated_at = ? WHERE id = ?`
    ).run(now, now, subscriptionId);

    // Prune: keep only last 100 events per subscription
    db.prepare(
      `DELETE FROM webhook_events WHERE subscription_id = ? AND id NOT IN (
         SELECT id FROM webhook_events WHERE subscription_id = ? ORDER BY received_at DESC LIMIT 100
       )`
    ).run(subscriptionId, subscriptionId);
  });

  recordTx();

  return {
    id,
    subscriptionId,
    eventType,
    payloadSummary: truncatedSummary ?? "",
    result: truncatedResult,
    error,
    receivedAt: now,
  };
}

interface WebhookEventRow {
  id: string;
  subscription_id: string;
  event_type: string;
  payload_summary: string | null;
  result: string | null;
  error: string | null;
  received_at: string;
}

export function listWebhookEvents(subscriptionId: string, limit = 50): WebhookEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM webhook_events WHERE subscription_id = ? ORDER BY received_at DESC LIMIT ?")
    .all(subscriptionId, limit) as WebhookEventRow[];
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    eventType: r.event_type,
    payloadSummary: r.payload_summary ?? "",
    result: r.result,
    error: r.error,
    receivedAt: r.received_at,
  }));
}

/** Count webhook events for a subscription within the last `windowMs` milliseconds. */
export function countRecentWebhookEvents(subscriptionId: string, windowMs: number): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM webhook_events WHERE subscription_id = ? AND received_at > ?")
    .get(subscriptionId, cutoff) as { count: number };
  return row.count;
}
