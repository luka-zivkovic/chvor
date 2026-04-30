import type { CredentialSummary, CredentialType } from "./credential.js";
import type { Skill, Tool } from "./capability.js";
import type { Workspace, WorkspaceMode } from "./workspace.js";
import type { AnyProviderDef } from "./provider.js";
import type { CommandApprovalRequest, CommandApprovalResponse } from "./shell.js";
import type { ActivityEntry } from "./activity.js";
import type { A2UISurfaceUpdate, A2UIDataModelUpdate, A2UIDeleteSurface } from "./a2ui.js";
import type { CognitiveLoopEvent, CognitiveLoopRun } from "./cognitive-loop.js";
import type { ProviderField } from "./provider.js";

// ── Credential request (server-triggered modal) ────────────────

export interface CredentialRequestData {
  requestId: string;
  providerName: string;
  providerIcon: string;
  credentialType: string;
  fields: ProviderField[];
  source: "provider-registry" | "chvor-registry" | "ai-research";
  registryEntryId?: string;
  /** AI-research confidence; "fallback" means generic apiKey+baseUrl shape (low trust). */
  confidence?: "researched" | "inferred" | "fallback";
  helpText?: string;
  /** OpenAPI spec URL the AI proposed (may or may not be verified). */
  specUrl?: string;
  /** True iff the server fetched specUrl and confirmed it parses as OpenAPI. */
  specVerified?: boolean;
  /** Auth scheme the AI proposed: bearer, basic, header, query-param, oauth2, etc. */
  authScheme?: string;
  /** Base URL the AI proposed for the API. Used by the modal's "Test connection" probe. */
  baseUrl?: string;
  /** Optional probe path for the test-connection check (e.g. `/me`, `/v1/account`). */
  probePath?: string;
  allowFieldEditing: boolean;
  existingCredentialId?: string;
  redactedValues?: Record<string, string>;
  timestamp: string;
}

export interface CredentialResponseData {
  requestId: string;
  cancelled: boolean;
  data?: Record<string, string>;
  name?: string;
}

// ── Synthesized OAuth wizard (server-triggered, for unknown OAuth services) ─

export interface OAuthSynthesizedWizardData {
  requestId: string;
  /** Stable provider slug used as the credential type (e.g. "quickbooks"). */
  credentialType: string;
  providerName: string;
  /** Discovered or AI-suggested OAuth endpoints. User can override before launch. */
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  /** Help text the AI surfaces — usually "where to register your app". */
  helpText?: string;
  /** Where the user should register the redirect URL with the provider. */
  redirectUriHint?: string;
  /** ISO timestamp the request was issued. */
  timestamp: string;
}

export interface OAuthSynthesizedWizardResponse {
  requestId: string;
  cancelled: boolean;
  /** True iff the OAuth callback completed successfully and tokens were stored. */
  connected?: boolean;
}

// ── Synthesized tool call confirmation (server-triggered modal) ─

export interface SynthesizedConfirmData {
  requestId: string;
  toolId: string;
  toolName: string;
  endpointName: string;
  method: string;
  path: string;
  resolvedUrl: string;
  /**
   * @deprecated kept for backward compat; clients should prefer pathParams/queryParams/body.
   * Truncated JSON.stringify of {path, query, body}.
   */
  argsPreview: string;
  /** Resolved path-template variables (e.g. {realmId} → "1234"). */
  pathParams?: Record<string, string | number>;
  /** Resolved query string parameters. */
  queryParams?: Record<string, string | number | boolean>;
  /** Request body for non-GET calls. Already typed as `unknown` because services vary. */
  body?: unknown;
  verified: boolean;
  source: "openapi" | "ai-draft";
  options: Array<"allow-once" | "allow-session" | "deny">;
  timestamp: string;
  /** Server timeout in milliseconds — client can display a matching countdown. */
  timeoutMs: number;
}

export interface SynthesizedResponseData {
  requestId: string;
  decision: "allow-once" | "allow-session" | "deny";
}

// Credential endpoints
export interface CreateCredentialRequest {
  name: string;
  type: CredentialType;
  data: Record<string, string>;
  usageContext?: string;
}

export interface UpdateCredentialRequest {
  name?: string;
  data?: Record<string, string>;
  usageContext?: string;
}

export interface TestCredentialRequest {
  type: CredentialType;
  data: Record<string, string>;
}

export interface TestCredentialResponse {
  success: boolean;
  error?: string;
}

// Workspace endpoints
export interface CreateWorkspaceRequest {
  name: string;
  mode: WorkspaceMode;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  data: {
    nodes: Workspace["nodes"];
    edges: Workspace["edges"];
    viewport: Workspace["viewport"];
    settings: Workspace["settings"];
  };
}

// Gateway WebSocket events (client <-> server)
export type GatewayClientEvent =
  | { type: "chat.send"; data: { text: string; workspaceId: string; inputModality?: "voice"; media?: import("./message.js").MediaArtifact[]; messageId?: string } }
  | { type: "chat.stop"; data: Record<string, never> }
  | { type: "canvas.subscribe"; data: { workspaceId: string } }
  | { type: "session.init"; data: { sessionId: string } }
  | { type: "command.respond"; data: CommandApprovalResponse }
  | { type: "credential.respond"; data: CredentialResponseData }
  | { type: "synthesized.respond"; data: SynthesizedResponseData }
  | { type: "oauth.synthesized.respond"; data: OAuthSynthesizedWizardResponse }
  | { type: "approval.respond"; data: import("./approval.js").ApprovalResponseData }
  | { type: "heartbeat"; data: Record<string, never> };

export type GatewayServerEvent =
  | { type: "chat.message"; data: { role: "assistant"; content: string; timestamp: string; messageId?: string; media?: import("./message.js").MediaArtifact[] } }
  | { type: "chat.chunk"; data: { content: string } }
  | { type: "chat.streamEnd"; data: Record<string, never> }
  | { type: "chat.streamReset"; data: Record<string, never> }
  | { type: "session.ack"; data: { sessionId: string } }
  | { type: "execution.event"; data: import("./execution.js").ExecutionEvent; sourceChannel?: string }
  | { type: "schedule.created"; data: import("./schedule.js").Schedule }
  | { type: "schedule.updated"; data: import("./schedule.js").Schedule }
  | { type: "schedule.deleted"; data: { id: string } }
  | { type: "chat.audio"; data: { audioUrl: string; duration?: number; messageId: string } }
  | { type: "voice.status"; data: { state: "transcribing" | "synthesizing" | "ready" } }
  | { type: "command.confirm"; data: CommandApprovalRequest }
  | { type: "credential.request"; data: CredentialRequestData }
  | { type: "oauth.synthesized.wizard"; data: OAuthSynthesizedWizardData }
  | { type: "synthesized.confirm"; data: SynthesizedConfirmData }
  | { type: "approval.requested"; data: import("./approval.js").ApprovalRequestedEvent }
  | { type: "approval.resolved"; data: { approvalId: string; status: "allowed" | "denied" | "expired"; decision: import("./approval.js").ApprovalDecision | null } }
  | { type: "chat.stopped"; data: Record<string, never> }
  | { type: "chat.welcome"; data: { content: string; aiName: string } }
  | { type: "chat.modelInfo"; data: { providerId: string; model: string; wasFallback: boolean } }
  | { type: "error"; data: { message: string } }
  | { type: "session.titleUpdate"; data: { sessionId: string; title: string } }
  | { type: "activity.new"; data: ActivityEntry }
  | { type: "webhook.created"; data: Omit<import("./webhook.js").WebhookSubscription, "secret"> }
  | { type: "webhook.updated"; data: Omit<import("./webhook.js").WebhookSubscription, "secret"> }
  | { type: "webhook.deleted"; data: { id: string } }
  | { type: "webhook.received"; data: { id: string; eventType: string } }
  | { type: "whatsapp.qr"; data: { qrDataUrl: string } }
  | { type: "whatsapp.status"; data: { status: "connecting" | "connected" | "disconnected"; phoneNumber?: string } }
  | { type: "skills.reloaded"; data: Record<string, never> }
  | { type: "registry.updatesAvailable"; data: { count: number; skills: { id: string; current: string; available: string }[] } }
  | { type: "a2ui.surface"; data: A2UISurfaceUpdate & { root?: string } }
  | { type: "a2ui.data"; data: A2UIDataModelUpdate }
  | { type: "a2ui.delete"; data: A2UIDeleteSurface }
  | { type: "a2ui.deleteAll"; data: Record<string, never> }
  | { type: "a2ui.toast"; data: { surfaceId: string; title: string } }
  | { type: "pc.connected"; data: import("./pc-control.js").PcAgentInfo }
  | { type: "pc.disconnected"; data: { id: string } }
  | { type: "pc.frame"; data: { agentId: string; screenshot: string; width: number; height: number; mimeType: string } }
  | { type: "pc.localAvailable"; data: { available: boolean; hostname: string; os: string } }
  | { type: "daemon.presence"; data: import("./daemon.js").DaemonPresence }
  | { type: "daemon.taskUpdate"; data: import("./daemon.js").DaemonTask }
  | { type: "cognitive.loop.run"; data: CognitiveLoopRun }
  | { type: "cognitive.loop.event"; data: CognitiveLoopEvent }
  | { type: "system.shutdown"; data: { reason: string } }
  | { type: "heartbeat"; data: Record<string, never> };

export interface ConversationSummary {
  id: string;
  title: string | null;
  channelType: string;
  channelId: string;
  threadId?: string;
  messageCount: number;
  preview: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

// API response wrapper
export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: string;
}

// List responses
export type CredentialListResponse = ApiResponse<CredentialSummary[]>;
export type SkillListResponse = ApiResponse<Skill[]>;
export type ToolListResponse = ApiResponse<Tool[]>;
export type WorkspaceListResponse = ApiResponse<Workspace[]>;
export type ProviderListResponse = ApiResponse<AnyProviderDef[]>;
