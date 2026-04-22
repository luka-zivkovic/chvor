import { tool } from "ai";
import { z } from "zod";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Webhook tools
// ---------------------------------------------------------------------------

export const CREATE_WEBHOOK_NAME = "native__create_webhook";

const createWebhookToolDef = tool({
  description:
    "[Create Webhook] Subscribe to incoming webhooks from external services (GitHub, Notion, Gmail, or any generic webhook). Creates a webhook URL that you give to the external service. When events arrive, the AI processes them using the prompt template and optionally delivers results to a channel.",
  parameters: z.object({
    name: z.string().describe("Human-readable name for this webhook subscription"),
    source: z
      .enum(["github", "notion", "gmail", "generic"])
      .describe("The source service sending webhooks"),
    promptTemplate: z
      .string()
      .describe(
        "Template for the AI prompt when a webhook fires. Use {{event.type}}, {{event.summary}}, {{event.details.*}}, or {{payload}} placeholders."
      ),
    deliverToChannel: z
      .enum(["telegram", "discord", "slack"])
      .optional()
      .describe("Optional channel to deliver the AI response to"),
    filterEventTypes: z
      .array(z.string())
      .optional()
      .describe("Optional event types to filter (e.g. ['pull_request.opened', 'issues.closed'])"),
  }),
});

const handleCreateWebhook: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { createWebhookSubscription } = await import("../../db/webhook-store.ts");
  const { getWSInstance } = await import("../../gateway/ws-instance.ts");

  const name = String(args.name);
  const source = String(args.source) as "github" | "notion" | "gmail" | "generic";
  const promptTemplate = String(args.promptTemplate);

  let deliverTo = null;
  if (args.deliverToChannel && context?.channelId) {
    deliverTo = [
      {
        channelType: String(args.deliverToChannel) as "telegram" | "discord" | "slack",
        channelId: context.channelId,
      },
    ];
  }

  const filters = args.filterEventTypes
    ? { eventTypes: args.filterEventTypes as string[] }
    : null;

  const sub = createWebhookSubscription({
    name,
    source,
    promptTemplate,
    deliverTo,
    filters,
  });

  // Strip secret before broadcasting — it should never reach the client via WebSocket
  const { secret: _secret, ...safeSub } = sub;
  getWSInstance()?.broadcast({ type: "webhook.created", data: safeSub });

  return {
    content: [
      {
        type: "text",
        text: `Webhook subscription created!\n\n**Name:** ${sub.name}\n**Source:** ${sub.source}\n**ID:** ${sub.id}\n\n**Webhook URL:** \`/api/webhooks/${sub.id}/receive\`\n\nThe signing secret can be viewed in **Settings → Webhooks**. ${source === "github" ? "In GitHub, paste the secret into the webhook settings for HMAC-SHA256 signature verification." : source === "generic" ? "Sign the request body with HMAC-SHA256 using the secret and send it in the X-Webhook-Signature-256 header as `sha256=<hex>`." : ""}`,
      },
    ],
  };
};

export const LIST_WEBHOOKS_NAME = "native__list_webhooks";

const listWebhooksToolDef = tool({
  description:
    "[List Webhooks] List all webhook subscriptions with their status and last received info.",
  parameters: z.object({}),
});

const handleListWebhooks: NativeToolHandler = async (): Promise<NativeToolResult> => {
  const { listWebhookSubscriptions } = await import("../../db/webhook-store.ts");
  const subs = listWebhookSubscriptions();
  if (subs.length === 0) {
    return {
      content: [{ type: "text", text: "No webhook subscriptions found." }],
    };
  }

  const lines = subs.map((s) => {
    const status = s.enabled ? "enabled" : "paused";
    const lastReceived = s.lastReceivedAt ?? "never";
    const delivery =
      s.deliverTo && s.deliverTo.length > 0
        ? ` → ${s.deliverTo.map((d) => d.channelType).join(", ")}`
        : "";
    return `- [${status}] "${s.name}" (${s.source}) | last received: ${lastReceived}${delivery} | id: ${s.id}`;
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
};

export const DELETE_WEBHOOK_NAME = "native__delete_webhook";

const deleteWebhookToolDef = tool({
  description:
    "[Delete Webhook] Delete a webhook subscription by its ID. Use native__list_webhooks first to find the ID.",
  parameters: z.object({
    id: z.string().describe("The webhook subscription ID to delete"),
  }),
});

const handleDeleteWebhook: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const { deleteWebhookSubscription } = await import("../../db/webhook-store.ts");
  const { getWSInstance } = await import("../../gateway/ws-instance.ts");

  const id = String(args.id);
  const deleted = deleteWebhookSubscription(id);

  if (deleted) {
    getWSInstance()?.broadcast({ type: "webhook.deleted", data: { id } });
  }

  return {
    content: [
      {
        type: "text",
        text: deleted
          ? `Webhook subscription ${id} deleted.`
          : `Webhook subscription ${id} not found.`,
      },
    ],
  };
};

export const webhookModule: NativeToolModule = {
  defs: {
    [CREATE_WEBHOOK_NAME]: createWebhookToolDef,
    [LIST_WEBHOOKS_NAME]: listWebhooksToolDef,
    [DELETE_WEBHOOK_NAME]: deleteWebhookToolDef,
  },
  handlers: {
    [CREATE_WEBHOOK_NAME]: handleCreateWebhook,
    [LIST_WEBHOOKS_NAME]: handleListWebhooks,
    [DELETE_WEBHOOK_NAME]: handleDeleteWebhook,
  },
  mappings: {
    [CREATE_WEBHOOK_NAME]: { kind: "tool", id: "webhooks" },
    [LIST_WEBHOOKS_NAME]: { kind: "tool", id: "webhooks" },
    [DELETE_WEBHOOK_NAME]: { kind: "tool", id: "webhooks" },
  },
};
