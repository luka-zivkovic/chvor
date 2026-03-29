import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { CreateWebhookRequest, UpdateWebhookRequest } from "@chvor/shared";
import {
  listWebhookSubscriptions,
  getWebhookSubscription,
  createWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookEvents,
} from "../db/webhook-store.ts";
import { getWSInstance } from "../gateway/ws-instance.ts";
import { parseWebhookPayload, verifyGitHubSignature, verifyGenericSignature, verifyNotionSignature } from "../lib/webhook-parsers.ts";
import { executeWebhook, matchesFilters } from "../lib/webhook-executor.ts";

const webhooks = new Hono();

// ── CRUD routes (behind auth) ───────────────────────────

webhooks.get("/", (c) => {
  try {
    return c.json({ data: listWebhookSubscriptions() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

webhooks.get("/:id", (c) => {
  try {
    const sub = getWebhookSubscription(c.req.param("id"));
    if (!sub) return c.json({ error: "not found" }, 404);
    return c.json({ data: sub });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

webhooks.get("/:id/events", (c) => {
  try {
    const events = listWebhookEvents(c.req.param("id"));
    return c.json({ data: events });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

webhooks.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as CreateWebhookRequest;
    if (!body.name || !body.source || !body.promptTemplate) {
      return c.json(
        { error: "name, source, and promptTemplate are required" },
        400
      );
    }
    const sub = createWebhookSubscription(body);
    getWSInstance()?.broadcast({ type: "webhook.created", data: sub });

    const baseUrl = new URL(c.req.url).origin;
    const webhookUrl = `${baseUrl}/api/webhooks/${sub.id}/receive`;

    return c.json({ data: { ...sub, webhookUrl } }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

webhooks.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateWebhookRequest;
    const updated = updateWebhookSubscription(id, body);
    if (!updated) return c.json({ error: "not found" }, 404);
    getWSInstance()?.broadcast({ type: "webhook.updated", data: updated });
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

webhooks.delete("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const deleted = deleteWebhookSubscription(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    getWSInstance()?.broadcast({ type: "webhook.deleted", data: { id } });
    return c.json({ data: null });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Receiver endpoint (NO auth — external services call this) ──

webhooks.post("/:id/receive", async (c) => {
  const sub = getWebhookSubscription(c.req.param("id"));
  if (!sub) return c.json({ error: "not found" }, 404);
  if (!sub.enabled) return c.json({ error: "subscription disabled" }, 410);

  // Get raw body for signature verification
  const rawBody = await c.req.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = rawBody;
  }

  // Verify signature based on source
  switch (sub.source) {
    case "github": {
      const sig = c.req.header("x-hub-signature-256");
      if (!verifyGitHubSignature(sub.secret, rawBody, sig)) {
        return c.json({ error: "invalid signature" }, 401);
      }
      break;
    }
    case "notion": {
      // Notion verification challenge (initial setup handshake)
      if (typeof body === "object" && body !== null && (body as Record<string, unknown>).type === "url_verification") {
        return c.json({ challenge: (body as Record<string, unknown>).challenge });
      }
      // Notion sends HMAC-SHA256 in x-notion-signature header when a secret is configured.
      // If the subscription has a secret and the header is present, verify it.
      // Otherwise, fall back to the unique subscription UUID in the URL as baseline auth.
      if (sub.secret) {
        const notionSig = c.req.header("x-notion-signature");
        if (!notionSig || !verifyNotionSignature(sub.secret, rawBody, notionSig)) {
          return c.json({ error: "invalid signature" }, 401);
        }
      }
      break;
    }
    case "generic": {
      const sig = c.req.header("x-webhook-signature-256");
      if (!verifyGenericSignature(sub.secret, rawBody, sig)) {
        return c.json({ error: "invalid signature" }, 401);
      }
      break;
    }
    case "gmail": {
      // Gmail Pub/Sub sends base64-encoded JSON in message.data.
      // Verify the Bearer token in Authorization header matches the subscription secret.
      // This is the standard approach for Google Cloud Pub/Sub push subscriptions
      // when an audience/token is configured on the push endpoint.
      if (sub.secret) {
        const authHeader = c.req.header("authorization");
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
        if (!token || token.length !== sub.secret.length || !timingSafeEqual(Buffer.from(token), Buffer.from(sub.secret))) {
          return c.json({ error: "invalid authorization" }, 401);
        }
      }
      break;
    }
  }

  // Parse payload
  const headers = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    if (typeof value === "string") headers.set(key, value);
  }
  const parsed = parseWebhookPayload(sub.source, headers, body);

  // Check filters
  if (!matchesFilters(parsed, sub.filters)) {
    return c.json({ status: "filtered" }, 200);
  }

  // Respond immediately, process async
  executeWebhook(sub, parsed).catch((err) => {
    console.error(`[webhooks] unhandled execution error for "${sub.name}":`, err);
  });

  getWSInstance()?.broadcast({ type: "webhook.received", data: { id: sub.id, eventType: parsed.eventType } });

  return c.json({ status: "accepted" }, 200);
});

export default webhooks;
