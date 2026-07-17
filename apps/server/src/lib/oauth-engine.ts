/**
 * Durable OAuth2 PKCE handling for direct and synthesized providers.
 * Callback material is encrypted in SQLite and synthesized token traffic is
 * resolved once and pinned to the validated address.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IntegrationSetupMode } from "@chvor/shared";
import { getDb } from "../db/database.ts";
import {
  consumeIntegrationSetupSecretEnvelopeByState,
  createIntegrationSetupFlow,
  getIntegrationSetupFlow,
  lookupIntegrationSetupSecretEnvelopeByState,
  putIntegrationSetupSecretEnvelope,
  setIntegrationSetupDuplicateCandidates,
  transitionIntegrationSetupFlow,
} from "../db/integration-setup-store.ts";
import { pinnedHttpsRequest, resolveSafeSynthesizedTarget } from "./synthesized/network.ts";

const PENDING_FLOW_SCHEMA_VERSION = 1 as const;
const LEGACY_MANIFEST_VERSION = "0.0.0";
const TOKEN_VALUE_LIMIT = 65_536;
const TOKEN_RESPONSE_LIMIT = 128 * 1_024;
const TOKEN_TIMEOUT_MS = 30_000;
const ERROR_BODY_LIMIT = 4_096;
const SAFE_PROVIDER_CODE = /^[a-z][a-z0-9._-]{0,127}$/;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/;
const AUTH_RESERVED_PARAMS = new Set([
  "state",
  "redirect_uri",
  "client_id",
  "response_type",
  "scope",
  "code_challenge",
  "code_challenge_method",
]);
const TOKEN_RESERVED_PARAMS = new Set([
  "grant_type",
  "code",
  "code_verifier",
  "refresh_token",
  "client_secret",
  "redirect_uri",
  "client_id",
]);
const DENIAL_OR_ACCOUNT_PROVIDER_CODES = new Set([
  "access_denied",
  "account_selection_required",
  "authorization_denied",
  "consent_required",
  "interaction_required",
  "invalid_grant",
  "invalid_token",
  "login_required",
  "revoked",
  "revoked_token",
  "token_revoked",
  "user_cancelled",
  "user_denied",
]);
const APP_CONFIGURATION_PROVIDER_CODES = new Set([
  "client_authentication_failed",
  "invalid_client",
  "invalid_client_metadata",
  "invalid_redirect_uri",
  "invalid_request",
  "invalid_scope",
  "redirect_uri_mismatch",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
]);
const RETRYABLE_PROVIDER_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limited",
  "request_timeout",
  "server_error",
  "slow_down",
  "temporarily_unavailable",
  "too_many_requests",
]);
const TRUSTED_DIRECT_ENDPOINTS = new Set([
  "google|https://oauth2.googleapis.com/token",
  "reddit|https://www.reddit.com/api/v1/access_token",
]);

export interface OAuthProviderConfig {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  requiresSecret?: boolean;
  /** Synthesized is the safe default unless metadata exactly matches a trusted built-in. */
  networkMode?: "builtin" | "synthesized";
}

export interface OAuthAccountIdentity {
  source: "account_id" | "user_id" | "id_token.sub";
  value: string;
  label?: string;
}

export interface OAuthCallbackCorrelation {
  flowId?: string;
  credentialId?: string;
  connectionId?: string;
  errorCode?: string;
  duplicateCandidateIds?: string[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
  accountIdentity?: OAuthAccountIdentity;
}

/** Secret payload stored only inside an encrypted setup-store envelope. */
export interface PendingOAuthFlow {
  schemaVersion: typeof PENDING_FLOW_SCHEMA_VERSION;
  flowId: string;
  providerId: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  appCredentialId?: string;
  appCredentialType?: string;
  appCredentialEncryptedData?: string;
  oauthCredentialId?: string;
  oauthCredentialEncryptedData?: string;
  redirectUri: string;
  postMessageOrigin: string;
  createdAt: string;
  inlineProvider?: OAuthProviderConfig;
  inlineProviderName?: string;
  credentialType: string;
  oauthManifestCredentialId: string;
}

export interface GenerateAuthUrlOptions {
  flowId?: string;
  integrationId?: string;
  manifestVersion?: string;
  manifestCredentialId?: string;
  targetCredentialId?: string;
  oauthCredentialId?: string;
  mode?: IntegrationSetupMode;
  inlineProvider?: OAuthProviderConfig;
  inlineProviderName?: string;
  credentialType?: string;
  appCredentialId?: string;
  appCredentialType?: string;
  appCredentialEncryptedData?: string;
  oauthCredentialEncryptedData?: string;
  oauthManifestCredentialId?: string;
  postMessageOrigin?: string;
}

export interface GeneratedOAuthAuthorization {
  authUrl: string;
  state: string;
  flowId: string;
  expiresAt: string;
}

export type OAuthProviderErrorClassification =
  | "denial-or-account"
  | "app-configuration"
  | "retryable";

function normalizedProviderCode(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SAFE_PROVIDER_CODE.test(normalized) ? normalized : undefined;
}

/**
 * Safely reduce provider and transport failures to route-safe behavior.
 * Unknown, malformed, and network errors deliberately default to retryable so
 * an untrusted provider response cannot force a durable credential transition.
 */
export function classifyOAuthProviderError(error: unknown): OAuthProviderErrorClassification;
export function classifyOAuthProviderError(
  status: number | undefined,
  providerCode: unknown
): OAuthProviderErrorClassification;
export function classifyOAuthProviderError(
  errorOrStatus: unknown,
  suppliedProviderCode?: unknown
): OAuthProviderErrorClassification {
  const record =
    typeof errorOrStatus === "object" && errorOrStatus !== null
      ? (errorOrStatus as Record<string, unknown>)
      : undefined;
  const status =
    typeof errorOrStatus === "number"
      ? errorOrStatus
      : typeof record?.status === "number"
        ? record.status
        : undefined;
  const providerCode = normalizedProviderCode(
    suppliedProviderCode ??
      (typeof errorOrStatus === "string"
        ? errorOrStatus
        : (record?.providerCode ?? record?.error ?? record?.code))
  );

  if (providerCode && DENIAL_OR_ACCOUNT_PROVIDER_CODES.has(providerCode)) {
    return "denial-or-account";
  }
  if (providerCode && APP_CONFIGURATION_PROVIDER_CODES.has(providerCode)) {
    return "app-configuration";
  }
  if (
    (providerCode && RETRYABLE_PROVIDER_CODES.has(providerCode)) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500)
  ) {
    return "retryable";
  }
  return "retryable";
}

export class OAuthTokenRequestError extends Error {
  readonly providerCode: string | undefined;
  readonly classification: OAuthProviderErrorClassification;
  readonly terminal: boolean;

  constructor(
    readonly status: number,
    providerCode: unknown
  ) {
    const safeProviderCode = normalizedProviderCode(providerCode);
    super(
      `OAuth token request failed (${status}${safeProviderCode ? `, ${safeProviderCode}` : ""})`
    );
    this.name = "OAuthTokenRequestError";
    this.providerCode = safeProviderCode;
    this.classification = classifyOAuthProviderError(status, safeProviderCode);
    this.terminal = this.classification !== "retryable";
  }
}

export class OAuthDuplicateAccountError extends Error {
  constructor(readonly candidateIds: string[]) {
    super("OAuth account already exists and requires explicit selection");
    this.name = "OAuthDuplicateAccountError";
  }
}

export class OAuthCredentialDriftError extends Error {
  constructor(message = "OAuth credential metadata changed during authorization") {
    super(message);
    this.name = "OAuthCredentialDriftError";
  }
}

function exactHttpOrigin(value: string | undefined): string | undefined {
  if (!value || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultPostMessageOrigin(redirectUri: string): string {
  const configured = process.env.CHVOR_APP_ORIGIN?.trim();
  const callbackOrigin = exactHttpOrigin(new URL(redirectUri).origin);
  return exactHttpOrigin(configured) ?? callbackOrigin ?? "http://localhost:9147";
}

export function assertSafeOAuthExtraParams(
  params: unknown,
  kind: "authorization" | "token"
): asserts params is Record<string, string> | undefined {
  if (params === undefined) return;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError(`${kind} OAuth parameters must be an object`);
  }
  const entries = Object.entries(params);
  if (entries.length > 64) throw new RangeError(`too many ${kind} OAuth parameters`);
  const reserved = kind === "authorization" ? AUTH_RESERVED_PARAMS : TOKEN_RESERVED_PARAMS;
  for (const [key, value] of entries) {
    if (!key || key.length > 128 || typeof value !== "string" || value.length > 4_096) {
      throw new TypeError(`${kind} OAuth parameters must contain bounded string pairs`);
    }
    if (reserved.has(key.toLowerCase())) {
      throw new TypeError(`${kind} OAuth parameter ${key} is reserved`);
    }
  }
}

function safeExtraParams(params: unknown, kind: "authorization" | "token"): boolean {
  try {
    assertSafeOAuthExtraParams(params, kind);
    return true;
  } catch {
    return false;
  }
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url").slice(0, 128);
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(32).toString("base64url");
}

function defaultIntegrationId(providerId: string): string {
  return `oauth.${providerId}`;
}

function defaultManifestCredentialId(inline: boolean): string {
  return inline ? "oauth.synthesized" : "oauth.direct";
}

function prepareDurableFlow(
  provider: OAuthProviderConfig,
  options: GenerateAuthUrlOptions,
  credentialType: string
): { id: string; oauthCredentialId?: string } {
  let flow = options.flowId ? getIntegrationSetupFlow(options.flowId) : null;
  if (options.flowId && !flow) throw new TypeError("OAuth setup flow was not found");
  if (!flow) {
    flow = createIntegrationSetupFlow({
      integrationId: options.integrationId ?? defaultIntegrationId(provider.id),
      manifestVersion: options.manifestVersion ?? LEGACY_MANIFEST_VERSION,
      manifestCredentialId:
        options.manifestCredentialId ?? defaultManifestCredentialId(!!options.inlineProvider),
      targetCredentialId: options.targetCredentialId,
      oauthCredentialId: options.oauthCredentialId,
      credentialType,
      mode: options.mode ?? (options.oauthCredentialId ? "reauthenticate" : "setup"),
    });
  } else {
    const manifestBound = flow.manifestVersion !== LEGACY_MANIFEST_VERSION || flow.steps.length > 0;
    if (
      options.targetCredentialId !== undefined &&
      (manifestBound
        ? flow.targetCredentialId !== options.targetCredentialId
        : !!flow.targetCredentialId && flow.targetCredentialId !== options.targetCredentialId)
    ) {
      throw new TypeError("OAuth app credential does not match the durable setup flow");
    }
    if (
      options.oauthCredentialId !== undefined &&
      (manifestBound
        ? flow.oauthCredentialId !== options.oauthCredentialId
        : !!flow.oauthCredentialId && flow.oauthCredentialId !== options.oauthCredentialId)
    ) {
      throw new TypeError("OAuth account credential does not match the durable setup flow");
    }
  }
  if (["completed", "failed", "cancelled", "expired"].includes(flow.status)) {
    throw new TypeError("OAuth setup flow is no longer active");
  }
  const activeStep = flow.steps.find((step) => step.status === "active");
  if (activeStep && activeStep.kind !== "oauth") {
    throw new TypeError("OAuth setup flow has a different active step");
  }
  if (flow.steps.length > 0 && !activeStep) {
    throw new TypeError("OAuth setup flow has no active OAuth step");
  }
  if (flow.status === "awaiting-input" && flow.steps.length === 0) {
    flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
      status: "awaiting-oauth",
      failureCode: null,
    });
  } else if (flow.status !== "awaiting-oauth") {
    throw new TypeError(`OAuth setup flow is not ready (${flow.status})`);
  }
  const manifestBound = flow.manifestVersion !== LEGACY_MANIFEST_VERSION || flow.steps.length > 0;
  if (
    !manifestBound &&
    ((options.targetCredentialId && !flow.targetCredentialId) ||
      (options.oauthCredentialId && !flow.oauthCredentialId))
  ) {
    flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
      ...(options.targetCredentialId && !flow.targetCredentialId
        ? { targetCredentialId: options.targetCredentialId }
        : {}),
      ...(options.oauthCredentialId && !flow.oauthCredentialId
        ? { oauthCredentialId: options.oauthCredentialId }
        : {}),
    });
  }
  return {
    id: flow.id,
    ...(flow.oauthCredentialId ? { oauthCredentialId: flow.oauthCredentialId } : {}),
  };
}

export function generateAuthUrl(
  provider: OAuthProviderConfig,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
  options: GenerateAuthUrlOptions = {}
): GeneratedOAuthAuthorization {
  assertSafeOAuthExtraParams(provider.extraAuthParams, "authorization");
  assertSafeOAuthExtraParams(provider.extraTokenParams, "token");
  const credentialType = options.credentialType ?? `oauth-token-${provider.id}`;
  if (
    options.appCredentialId &&
    (!options.appCredentialType || !options.appCredentialEncryptedData)
  ) {
    throw new TypeError("OAuth app credential snapshot is required");
  }
  const durableFlow = prepareDurableFlow(provider, options, credentialType);
  if (durableFlow.oauthCredentialId && !options.oauthCredentialEncryptedData) {
    throw new TypeError("OAuth account credential snapshot is required");
  }
  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const pending: PendingOAuthFlow = {
    schemaVersion: PENDING_FLOW_SCHEMA_VERSION,
    flowId: durableFlow.id,
    providerId: provider.id,
    codeVerifier,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(options.appCredentialId ? { appCredentialId: options.appCredentialId } : {}),
    ...(options.appCredentialType ? { appCredentialType: options.appCredentialType } : {}),
    ...(options.appCredentialEncryptedData
      ? { appCredentialEncryptedData: options.appCredentialEncryptedData }
      : {}),
    ...(durableFlow.oauthCredentialId ? { oauthCredentialId: durableFlow.oauthCredentialId } : {}),
    ...(options.oauthCredentialEncryptedData
      ? { oauthCredentialEncryptedData: options.oauthCredentialEncryptedData }
      : {}),
    redirectUri,
    postMessageOrigin:
      exactHttpOrigin(options.postMessageOrigin) ?? defaultPostMessageOrigin(redirectUri),
    createdAt: new Date().toISOString(),
    ...(options.inlineProvider ? { inlineProvider: options.inlineProvider } : {}),
    ...(options.inlineProviderName ? { inlineProviderName: options.inlineProviderName } : {}),
    credentialType,
    oauthManifestCredentialId:
      options.oauthManifestCredentialId ?? defaultManifestCredentialId(!!options.inlineProvider),
  };
  const envelope = putIntegrationSetupSecretEnvelope({
    flowId: durableFlow.id,
    purpose: "pkce",
    payload: JSON.stringify(pending),
    state,
  });

  const authUrl = new URL(provider.authUrl);
  for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) {
    authUrl.searchParams.set(key, value);
  }
  // Mandatory protocol fields are always applied last as defense in depth.
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", provider.scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", generateCodeChallenge(codeVerifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  return {
    authUrl: authUrl.toString(),
    state,
    flowId: durableFlow.id,
    expiresAt: envelope.expiresAt,
  };
}

/** Pause a journaled OAuth step before authorization when account choices already exist. */
export function preflightOAuthAccountChoice(
  flowId: string | undefined,
  credentialType: string,
  manifestCredentialId: string
): { paused?: NonNullable<ReturnType<typeof getIntegrationSetupFlow>> } {
  if (!flowId) return {};
  return getDb()
    .transaction(() => {
      let flow = getIntegrationSetupFlow(flowId);
      if (!flow) return {};
      const active = flow.steps.find((step) => step.status === "active");
      if (flow.status === "awaiting-confirmation" && active?.kind === "oauth") {
        return { paused: flow };
      }
      if (
        flow.status !== "awaiting-oauth" ||
        active?.kind !== "oauth" ||
        flow.oauthCredentialId ||
        flow.oauthCreateAdditional
      ) {
        return {};
      }
      const candidates = (
        getDb()
          .prepare(
            `SELECT DISTINCT c.id FROM credentials c
             JOIN integration_credential_bindings b ON b.credential_id = c.id
             WHERE c.type = ? AND b.integration_id = ? AND b.manifest_credential_id = ?
               AND b.auth_method IN ('oauth', 'oauth2')
             ORDER BY c.id LIMIT 256`
          )
          .all(credentialType, flow.integrationId, manifestCredentialId) as Array<{ id: string }>
      ).map((row) => row.id);
      if (candidates.length === 0) return {};
      flow = setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, candidates);
      flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
        status: "awaiting-confirmation",
      });
      return { paused: flow };
    })
    .immediate();
}

function isString(value: unknown, max = TOKEN_VALUE_LIMIT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function validProvider(value: unknown): value is OAuthProviderConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<OAuthProviderConfig>;
  return (
    isString(item.id, 128) &&
    isString(item.name, 320) &&
    isString(item.authUrl, 2_048) &&
    isString(item.tokenUrl, 2_048) &&
    Array.isArray(item.scopes) &&
    item.scopes.every((scope) => isString(scope, 1_024)) &&
    (item.extraAuthParams === undefined || isStringRecord(item.extraAuthParams)) &&
    (item.extraTokenParams === undefined || isStringRecord(item.extraTokenParams)) &&
    safeExtraParams(item.extraAuthParams, "authorization") &&
    safeExtraParams(item.extraTokenParams, "token") &&
    (item.requiresSecret === undefined || typeof item.requiresSecret === "boolean") &&
    (item.networkMode === undefined || ["builtin", "synthesized"].includes(item.networkMode))
  );
}

function parsePendingFlow(payload: string, expectedFlowId: string): PendingOAuthFlow | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const flow = value as Partial<PendingOAuthFlow>;
  if (
    flow.schemaVersion !== PENDING_FLOW_SCHEMA_VERSION ||
    flow.flowId !== expectedFlowId ||
    !isString(flow.flowId, 256) ||
    !isString(flow.providerId, 128) ||
    !isString(flow.codeVerifier, 128) ||
    !isString(flow.clientId) ||
    !isString(flow.redirectUri, 2_048) ||
    !isString(flow.postMessageOrigin, 512) ||
    exactHttpOrigin(flow.postMessageOrigin) !== flow.postMessageOrigin ||
    !isString(flow.createdAt, 64) ||
    !isString(flow.credentialType, 128) ||
    !isString(flow.oauthManifestCredentialId, 128) ||
    (flow.clientSecret !== undefined && !isString(flow.clientSecret)) ||
    (flow.appCredentialId !== undefined && !isString(flow.appCredentialId, 256)) ||
    (flow.appCredentialType !== undefined && !isString(flow.appCredentialType, 128)) ||
    (flow.appCredentialEncryptedData !== undefined &&
      !isString(flow.appCredentialEncryptedData, 2_097_208)) ||
    (flow.oauthCredentialId !== undefined && !isString(flow.oauthCredentialId, 256)) ||
    (flow.oauthCredentialEncryptedData !== undefined &&
      !isString(flow.oauthCredentialEncryptedData, 2_097_208)) ||
    (flow.appCredentialId !== undefined &&
      (!flow.appCredentialType || !flow.appCredentialEncryptedData)) ||
    (flow.oauthCredentialId !== undefined && !flow.oauthCredentialEncryptedData) ||
    (flow.inlineProviderName !== undefined && !isString(flow.inlineProviderName, 320)) ||
    (flow.inlineProvider !== undefined && !validProvider(flow.inlineProvider))
  ) {
    return undefined;
  }
  return flow as PendingOAuthFlow;
}

export function getPendingFlow(state: string, now?: string): PendingOAuthFlow | undefined {
  const envelope = lookupIntegrationSetupSecretEnvelopeByState(state, now);
  if (!envelope || envelope.purpose !== "pkce") return undefined;
  return parsePendingFlow(envelope.payload, envelope.flowId);
}

/** Consume state synchronously before any network await. */
export function consumePendingFlow(state: string, now?: string): PendingOAuthFlow | undefined {
  const envelope = consumeIntegrationSetupSecretEnvelopeByState(state, "pkce", now);
  if (!envelope) return undefined;
  return parsePendingFlow(envelope.payload, envelope.flowId);
}

export function removePendingFlow(state: string): boolean {
  return consumeIntegrationSetupSecretEnvelopeByState(state, "pkce") !== null;
}

export function assertPendingOAuthFlowTargets(pending: PendingOAuthFlow): void {
  const flow = getIntegrationSetupFlow(pending.flowId);
  const appCredential = pending.appCredentialId
    ? (getDb()
        .prepare("SELECT type, encrypted_data FROM credentials WHERE id = ?")
        .get(pending.appCredentialId) as { type: string; encrypted_data: string } | undefined)
    : undefined;
  const oauthCredential = pending.oauthCredentialId
    ? (getDb()
        .prepare("SELECT encrypted_data FROM credentials WHERE id = ?")
        .get(pending.oauthCredentialId) as { encrypted_data: string } | undefined)
    : undefined;
  if (
    !flow ||
    flow.oauthCredentialId !== pending.oauthCredentialId ||
    (pending.appCredentialId && flow.targetCredentialId !== pending.appCredentialId) ||
    (pending.appCredentialId &&
      (!appCredential ||
        appCredential.type !== pending.appCredentialType ||
        appCredential.encrypted_data !== pending.appCredentialEncryptedData)) ||
    (pending.oauthCredentialId &&
      (!oauthCredential || oauthCredential.encrypted_data !== pending.oauthCredentialEncryptedData))
  ) {
    throw new OAuthCredentialDriftError();
  }
}

function providerErrorCode(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const candidate =
    typeof parsed === "object" && parsed !== null
      ? ((parsed as Record<string, unknown>).error ?? (parsed as Record<string, unknown>).code)
      : undefined;
  const normalized = normalizedProviderCode(candidate);
  if (normalized) return normalized;
  return raw
    .toLowerCase()
    .match(
      /access_denied|authorization_denied|invalid_grant|invalid_token|revoked_token|token_revoked|invalid_client|unauthorized_client|temporarily_unavailable|server_error/
    )?.[0];
}

function tokenError(status: number, body: string): OAuthTokenRequestError {
  const code = providerErrorCode(body.slice(0, ERROR_BODY_LIMIT));
  return new OAuthTokenRequestError(status, code);
}

function optionalTokenString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value)) throw new TypeError(`OAuth token response has invalid ${name}`);
  return value;
}

function parseExpiresAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError("OAuth token response has invalid expires_in");
  }
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function boundedIdentityValue(value: unknown): string | undefined {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof normalized !== "string" || normalized.length < 1 || normalized.length > 256) {
    return undefined;
  }
  return Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })
    ? undefined
    : normalized;
}

function boundedIdentityLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 320 && boundedIdentityValue(normalized)
    ? normalized
    : undefined;
}

function idTokenIdentity(value: unknown): OAuthAccountIdentity | undefined {
  if (typeof value !== "string" || value.length > TOKEN_VALUE_LIMIT) return undefined;
  const parts = value.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{1,8192}$/.test(parts[1])) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const sub = boundedIdentityValue(record.sub);
  if (!sub) return undefined;
  const label =
    boundedIdentityLabel(record.email) ?? boundedIdentityLabel(record.preferred_username);
  return { source: "id_token.sub", value: sub, ...(label ? { label } : {}) };
}

function extractAccountIdentity(record: Record<string, unknown>): OAuthAccountIdentity | undefined {
  const label =
    boundedIdentityLabel(record.account_name) ??
    boundedIdentityLabel(record.username) ??
    boundedIdentityLabel(record.email);
  const accountId = boundedIdentityValue(record.account_id);
  if (accountId) return { source: "account_id", value: accountId, ...(label ? { label } : {}) };
  const userId = boundedIdentityValue(record.user_id);
  if (userId) return { source: "user_id", value: userId, ...(label ? { label } : {}) };
  return idTokenIdentity(record.id_token);
}

function parseTokens(rawBody: string, previousRefreshToken?: string): OAuthTokens {
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new TypeError("OAuth token response was not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("OAuth token response must be an object");
  }
  const record = data as Record<string, unknown>;
  if (!isString(record.access_token)) {
    throw new TypeError("OAuth token response is missing access_token");
  }
  const refreshToken =
    optionalTokenString(record.refresh_token, "refresh_token") ?? previousRefreshToken;
  const expiresAt = parseExpiresAt(record.expires_in);
  const tokenType = optionalTokenString(record.token_type, "token_type");
  const scope = optionalTokenString(record.scope, "scope");
  const accountIdentity = extractAccountIdentity(record);
  return {
    accessToken: record.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(scope ? { scope } : {}),
    ...(accountIdentity ? { accountIdentity } : {}),
  };
}

function shouldPinTokenRequest(provider: OAuthProviderConfig): boolean {
  if (provider.networkMode === "synthesized") return true;
  if (provider.networkMode === "builtin") return false;
  return !TRUSTED_DIRECT_ENDPOINTS.has(`${provider.id}|${provider.tokenUrl}`);
}

async function readBoundedTokenResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > TOKEN_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new TypeError("OAuth token response exceeded the safe limit");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function tokenRequest(
  provider: OAuthProviderConfig,
  body: Record<string, string>,
  clientId: string,
  clientSecret?: string
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (provider.id === "reddit") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret ?? ""}`).toString("base64")}`;
  }
  const encodedBody = new URLSearchParams(body).toString();
  if (shouldPinTokenRequest(provider)) {
    const target = await resolveSafeSynthesizedTarget(provider.tokenUrl);
    const response = await pinnedHttpsRequest({
      target,
      method: "POST",
      headers,
      body: Buffer.from(encodedBody, "utf8"),
      timeoutMs: TOKEN_TIMEOUT_MS,
      maxBytes: TOKEN_RESPONSE_LIMIT,
    });
    if (response.truncated) throw new TypeError("OAuth token response exceeded the safe limit");
    if (response.status >= 300 && response.status < 400) {
      throw new OAuthTokenRequestError(response.status, "redirect_rejected");
    }
    return { status: response.status, body: response.body.toString("utf8") };
  }
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers,
    body: encodedBody,
    redirect: "manual",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new OAuthTokenRequestError(response.status, "redirect_rejected");
  }
  return { status: response.status, body: await readBoundedTokenResponse(response) };
}

export async function exchangeCode(
  provider: OAuthProviderConfig,
  code: string,
  flow: PendingOAuthFlow
): Promise<OAuthTokens> {
  assertSafeOAuthExtraParams(provider.extraTokenParams, "token");
  const body: Record<string, string> = {
    ...provider.extraTokenParams,
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.codeVerifier,
    ...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
  };
  const response = await tokenRequest(provider, body, flow.clientId, flow.clientSecret);
  if (response.status < 200 || response.status >= 300) {
    throw tokenError(response.status, response.body);
  }
  return parseTokens(response.body);
}

export async function refreshAccessToken(
  provider: OAuthProviderConfig,
  refreshToken: string,
  clientId: string,
  clientSecret?: string
): Promise<OAuthTokens> {
  assertSafeOAuthExtraParams(provider.extraTokenParams, "token");
  const body: Record<string, string> = {
    ...provider.extraTokenParams,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  };
  const response = await tokenRequest(provider, body, clientId, clientSecret);
  if (response.status < 200 || response.status >= 300) {
    throw tokenError(response.status, response.body);
  }
  return parseTokens(response.body, refreshToken);
}

export function safeOAuthCorrelationId(value: string | undefined): string | undefined {
  return value && SAFE_CORRELATION_ID.test(value) ? value : undefined;
}

export function boundedOAuthMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return normalized ? normalized.slice(0, 200) : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Render the popup callback without interpolating untrusted values into script source. */
export function callbackHtml(
  success: boolean,
  message: string,
  correlation: OAuthCallbackCorrelation = {},
  targetOrigin?: string
): string {
  const safeMessage = escapeHtml(
    boundedOAuthMessage(message, success ? "Connected" : "OAuth failed")
  );
  const callbackUrl =
    process.env.OAUTH_CALLBACK_URL ??
    `http://localhost:${Number(process.env.PORT ?? 9147)}/api/oauth/callback`;
  const validOrigin = exactHttpOrigin(targetOrigin) ?? defaultPostMessageOrigin(callbackUrl);
  const payload = {
    type: "chvor-oauth-callback",
    success,
    ...(safeOAuthCorrelationId(correlation.flowId)
      ? { flowId: safeOAuthCorrelationId(correlation.flowId) }
      : {}),
    ...(safeOAuthCorrelationId(correlation.credentialId)
      ? { credentialId: safeOAuthCorrelationId(correlation.credentialId) }
      : {}),
    ...(safeOAuthCorrelationId(correlation.connectionId)
      ? { connectionId: safeOAuthCorrelationId(correlation.connectionId) }
      : {}),
    ...(safeOAuthCorrelationId(correlation.errorCode)
      ? { errorCode: safeOAuthCorrelationId(correlation.errorCode) }
      : {}),
    ...(correlation.duplicateCandidateIds
      ? {
          duplicateCandidateIds: correlation.duplicateCandidateIds
            .map((candidateId) => safeOAuthCorrelationId(candidateId))
            .filter((candidateId): candidateId is string => !!candidateId)
            .slice(0, 256),
        }
      : {}),
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chvor — ${success ? "Connected" : "Error"}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; margin: 0; background: #181818; color: #e4e4e8; }
    .card { text-align: center; padding: 3rem; border-radius: 1rem; background: #222; max-width: 420px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #999; font-size: 0.95rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
    <h1>${safeMessage}</h1>
    <p>${success ? "You can close this tab and return to Chvor." : "Please try again in Chvor."}</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage(${inlineJson(payload)}, ${inlineJson(validOrigin)});
    }
  </script>
</body>
</html>`;
}
