import type { DeliveryTarget } from "./schedule.js";

export type WebhookSource = "github" | "notion" | "gmail" | "generic";

export interface WebhookSubscription {
  id: string;
  name: string;
  source: WebhookSource;
  secret: string;
  promptTemplate: string;
  workspaceId: string;
  enabled: boolean;
  deliverTo: DeliveryTarget[] | null;
  filters: WebhookFilter | null;
  lastReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookFilter {
  eventTypes?: string[];
  branches?: string[];
  custom?: Record<string, string>;
}

export interface CreateWebhookRequest {
  name: string;
  source: WebhookSource;
  promptTemplate: string;
  workspaceId?: string;
  deliverTo?: DeliveryTarget[] | null;
  filters?: WebhookFilter | null;
}

export interface UpdateWebhookRequest {
  name?: string;
  promptTemplate?: string;
  enabled?: boolean;
  deliverTo?: DeliveryTarget[] | null;
  filters?: WebhookFilter | null;
}

export interface WebhookEvent {
  id: string;
  subscriptionId: string;
  eventType: string;
  payloadSummary: string;
  result: string | null;
  error: string | null;
  receivedAt: string;
}

export interface ParsedWebhookEvent {
  eventType: string;
  summary: string;
  details: Record<string, unknown>;
  rawPayload: unknown;
}
