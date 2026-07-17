/** Background and on-demand refresh for direct and synthesized OAuth tokens. */

import type { IntegrationAuthStatus } from "@chvor/shared";
import {
  getCredentialData,
  listCredentialMetadata,
  updateCredentialDataIfUnchanged,
} from "../db/credential-store.ts";
import { getDb } from "../db/database.ts";
import {
  acquireOAuthRefreshLease,
  getOAuthRefreshLeaseMonotonicTime,
  isOAuthRefreshLeaseHeld,
  OAUTH_REFRESH_LEASE_TTL_MS,
  releaseOAuthRefreshLease,
  renewOAuthRefreshLease,
} from "../db/oauth-refresh-lease-store.ts";
import {
  getIntegrationCredentialBinding,
  updateIntegrationCredentialAuthState,
  upsertIntegrationCredentialBinding,
  type IntegrationCredentialBinding,
  type IntegrationCredentialBindingKey,
} from "../db/integration-setup-store.ts";
import {
  assertCredentialAuthUsable,
  CredentialReauthenticationRequiredError,
} from "./credential-auth-usability.ts";
import { OAUTH_PROVIDERS } from "./provider-registry.ts";
import { getDirectOAuthProvider } from "./oauth-providers.ts";
import { assertSafeUrl } from "./url-safety.ts";
import {
  assertSafeOAuthExtraParams,
  classifyOAuthProviderError,
  OAuthTokenRequestError,
  refreshAccessToken,
  type OAuthProviderConfig,
} from "./oauth-engine.ts";

const REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
const EXPIRY_THRESHOLD_MS = 10 * 60 * 1_000;
const REFRESH_LEASE_POLL_MS = 50;
const REFRESH_LEASE_WAIT_MS = OAUTH_REFRESH_LEASE_TTL_MS * 2;
const REFRESH_LEASE_RENEW_MS = Math.floor(OAUTH_REFRESH_LEASE_TTL_MS / 3);
const LEGACY_MANIFEST_VERSION = "0.0.0";
const DIRECT_OAUTH_APP_CREDENTIAL_TYPES = new Set(
  OAUTH_PROVIDERS.flatMap((provider) =>
    provider.setupCredentialType ? [provider.setupCredentialType] : []
  )
);
let intervalId: ReturnType<typeof setInterval> | null = null;
const refreshFlights = new Map<string, Promise<OAuthRefreshResult>>();

type OAuthCredentialData = Record<string, string>;

export interface OAuthRefreshResult {
  credentialId: string;
  outcome: "refreshed" | "skipped" | "failed";
  terminal?: boolean;
  failureCode?: string;
  expiresAt?: string;
}

interface DirectOAuthAppCredentialSnapshot {
  credentialId: string;
  credentialType: string;
  encryptedData: string;
  clientId: string;
  clientSecret?: string;
}

interface OAuthTokenTuple {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

interface OAuthRefreshObservationSnapshot {
  encryptedData: string;
  credentialType: string;
  binding: IntegrationCredentialBindingKey & { manifestVersion: string };
  tokens: OAuthTokenTuple;
}

class OAuthAppCredentialChangedError extends Error {
  constructor() {
    super("OAuth app credential changed during token refresh");
    this.name = "OAuthAppCredentialChangedError";
  }
}

class OAuthRefreshLeaseLostError extends Error {
  constructor() {
    super("OAuth refresh lease expired before commit");
    this.name = "OAuthRefreshLeaseLostError";
  }
}

function parseStringRecord(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((item) => typeof item === "string")
    ) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Ignore malformed optional legacy metadata.
  }
  return undefined;
}

function splitScopes(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/\s+/).filter(Boolean))].slice(0, 128);
}

export function isOAuthCredentialData(type: string, data: OAuthCredentialData): boolean {
  return (
    type.startsWith("oauth-token-") ||
    data.oauthKind === "synthesized" ||
    (!!data.accessToken && !!data.provider && !!data.tokenUrl && !!data.clientId)
  );
}

function usesSynthesizedOAuthMetadata(data: OAuthCredentialData): boolean {
  return data.oauthKind === "synthesized" || (!data.oauthKind && !!data.tokenUrl);
}

export function getOAuthBindingIdentity(
  credentialId: string,
  type: string,
  data: OAuthCredentialData
): IntegrationCredentialBindingKey & { manifestVersion: string } {
  const platform = data.provider || type.replace(/^oauth-token-/, "");
  const synthesized = usesSynthesizedOAuthMetadata(data) || !type.startsWith("oauth-token-");
  return {
    credentialId,
    integrationId: data.oauthIntegrationId || `oauth.${platform}`,
    manifestCredentialId:
      data.oauthManifestCredentialId || (synthesized ? "oauth.synthesized" : "oauth.direct"),
    manifestVersion: data.oauthManifestVersion || LEGACY_MANIFEST_VERSION,
  };
}

function initialAuthStatus(data: OAuthCredentialData, now: number): IntegrationAuthStatus {
  if (data.expiresAt && Date.parse(data.expiresAt) <= now) {
    return data.refreshToken ? "expired" : "reauthentication-required";
  }
  return "active";
}

export function ensureOAuthCredentialBinding(
  credentialId: string,
  type: string,
  data: OAuthCredentialData,
  now = Date.now()
): IntegrationCredentialBinding {
  return getDb()
    .transaction(() => {
      // Always re-read after taking the write lock. Callers commonly arrive
      // with a snapshot captured before a refresh in another process; using
      // that snapshot here could recreate or expire a binding that the newer
      // refresh has already made active.
      const current = getCredentialData(credentialId);
      const currentData = current?.data as OAuthCredentialData | undefined;
      const currentType = current?.cred.type;
      const bindingData =
        currentData && currentType && isOAuthCredentialData(currentType, currentData)
          ? currentData
          : data;
      const bindingType = currentType ?? type;
      const identity = getOAuthBindingIdentity(credentialId, bindingType, bindingData);
      let binding = getIntegrationCredentialBinding(identity);
      if (!binding) {
        const status = initialAuthStatus(bindingData, now);
        binding = upsertIntegrationCredentialBinding({
          ...identity,
          authMethod: "oauth2",
          authStatus: status,
          ...(status === "reauthentication-required"
            ? { failureCode: "oauth_refresh_unavailable" }
            : {}),
          tokenExpiresAt: bindingData.expiresAt || null,
          scopes: splitScopes(bindingData.scope || bindingData.scopes),
        });
      }

      const expiresAt = bindingData.expiresAt || binding.tokenExpiresAt;
      const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
      if (
        (binding.authStatus === "active" || binding.authStatus === "unknown") &&
        Number.isFinite(expiry) &&
        expiry <= now
      ) {
        binding = updateIntegrationCredentialAuthState(binding, {
          authStatus: bindingData.refreshToken ? "expired" : "reauthentication-required",
          failureCode: bindingData.refreshToken ? null : "oauth_refresh_unavailable",
          tokenExpiresAt: expiresAt,
        });
      }
      return binding;
    })
    .immediate();
}

export function getOAuthProviderConfigForCredential(
  data: OAuthCredentialData
): OAuthProviderConfig | undefined {
  const direct =
    usesSynthesizedOAuthMetadata(data) || !data.provider
      ? undefined
      : getDirectOAuthProvider(data.provider);
  if (direct) return direct;
  if (!data.provider || !data.tokenUrl) return undefined;
  try {
    assertSafeUrl(data.tokenUrl, "synthesized OAuth tokenUrl");
    if (new URL(data.tokenUrl).protocol !== "https:") return undefined;
    if (data.authUrl) {
      assertSafeUrl(data.authUrl, "synthesized OAuth authUrl");
      if (new URL(data.authUrl).protocol !== "https:") return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    id: data.provider,
    name: data.oauthProviderName || data.provider,
    authUrl: data.authUrl || data.tokenUrl,
    tokenUrl: data.tokenUrl,
    scopes: splitScopes(data.scopes || data.scope),
    extraTokenParams: parseStringRecord(data.extraTokenParams),
    requiresSecret: !!data.clientSecret,
    networkMode: "synthesized",
  };
}

export function getDirectAppCredentialForToken(
  providerId: string,
  data: OAuthCredentialData
): DirectOAuthAppCredentialSnapshot | null {
  const provider = OAUTH_PROVIDERS.find((item) => item.id === providerId);
  if (!provider?.setupCredentialType) return null;
  const candidates = listCredentialMetadata().filter(
    (item) => item.type === provider.setupCredentialType
  );
  const readCandidate = (credentialId: string): DirectOAuthAppCredentialSnapshot | null => {
    try {
      assertCredentialAuthUsable(credentialId);
    } catch (error) {
      if (error instanceof CredentialReauthenticationRequiredError) return null;
      throw error;
    }
    const stored = getCredentialData(credentialId);
    const selected = stored?.data as OAuthCredentialData | undefined;
    if (!stored || stored.cred.type !== provider.setupCredentialType || !selected?.clientId) {
      return null;
    }
    return {
      credentialId,
      credentialType: stored.cred.type,
      encryptedData: stored.cred.encryptedData,
      clientId: selected.clientId,
      ...(selected.clientSecret ? { clientSecret: selected.clientSecret } : {}),
    };
  };

  let matching: DirectOAuthAppCredentialSnapshot[];
  if (data.oauthAppCredentialId) {
    const exact = candidates.find((item) => item.id === data.oauthAppCredentialId);
    if (!exact) return null;
    const selected = readCandidate(exact.id);
    if (!selected || selected.clientId !== data.clientId) return null;
    matching = [selected];
  } else {
    matching = candidates.flatMap((item) => {
      const selected = readCandidate(item.id);
      if (!selected) return [];
      return data.clientId && selected.clientId === data.clientId ? [selected] : [];
    });
  }
  if (matching.length !== 1) return null;
  return matching[0];
}

function assertDirectAppCredentialUnchanged(snapshot: DirectOAuthAppCredentialSnapshot): void {
  try {
    assertCredentialAuthUsable(snapshot.credentialId);
  } catch (error) {
    if (error instanceof CredentialReauthenticationRequiredError) {
      throw new OAuthAppCredentialChangedError();
    }
    throw error;
  }
  const row = getDb()
    .prepare("SELECT type, encrypted_data FROM credentials WHERE id = ?")
    .get(snapshot.credentialId) as { type: string; encrypted_data: string } | undefined;
  if (
    !row ||
    row.type !== snapshot.credentialType ||
    row.encrypted_data !== snapshot.encryptedData
  ) {
    throw new OAuthAppCredentialChangedError();
  }
}

function failureCodeFor(error: OAuthTokenRequestError): string {
  const suffix = error.providerCode?.replace(/[^a-z0-9._-]/g, "_") || "revoked";
  return `oauth_${suffix}`.slice(0, 128);
}

function oauthTokenTuple(data: OAuthCredentialData): OAuthTokenTuple {
  return {
    ...(data.accessToken ? { accessToken: data.accessToken } : {}),
    ...(data.refreshToken ? { refreshToken: data.refreshToken } : {}),
    ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    ...(data.scope || data.scopes ? { scope: data.scope ?? data.scopes } : {}),
  };
}

function sameOAuthTokenTuple(left: OAuthTokenTuple, right: OAuthTokenTuple): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.scope === right.scope
  );
}

function sameOAuthBindingIdentity(
  left: OAuthRefreshObservationSnapshot["binding"],
  right: OAuthRefreshObservationSnapshot["binding"]
): boolean {
  return (
    left.credentialId === right.credentialId &&
    left.integrationId === right.integrationId &&
    left.manifestCredentialId === right.manifestCredentialId &&
    left.manifestVersion === right.manifestVersion
  );
}

function observedRemoteRefresh(
  credentialId: string,
  expected: OAuthRefreshObservationSnapshot
): OAuthRefreshResult | null {
  const row = getDb()
    .prepare("SELECT encrypted_data FROM credentials WHERE id = ?")
    .get(credentialId) as { encrypted_data: string } | undefined;
  if (!row) {
    return { credentialId, outcome: "skipped", failureCode: "credential_not_found" };
  }
  if (row.encrypted_data === expected.encryptedData) return null;
  const current = getCredentialData(credentialId);
  const currentData = current?.data as OAuthCredentialData | undefined;
  if (
    !current ||
    !currentData ||
    current.cred.type !== expected.credentialType ||
    !isOAuthCredentialData(current.cred.type, currentData) ||
    sameOAuthTokenTuple(expected.tokens, oauthTokenTuple(currentData))
  ) {
    return null;
  }
  const currentIdentity = getOAuthBindingIdentity(credentialId, current.cred.type, currentData);
  if (!sameOAuthBindingIdentity(expected.binding, currentIdentity)) return null;
  const currentBinding = getIntegrationCredentialBinding(expected.binding);
  if (
    currentBinding?.authStatus !== "active" ||
    currentBinding.manifestVersion !== expected.binding.manifestVersion
  ) {
    return null;
  }
  return {
    credentialId,
    outcome: "refreshed",
    ...(currentData?.expiresAt ? { expiresAt: currentData.expiresAt } : {}),
  };
}

function systemWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
let waitForLeasePoll = systemWait;

export function _setOAuthRefreshLeaseWaitForTests(
  waiter: (delayMs: number) => Promise<void>
): () => void {
  const previous = waitForLeasePoll;
  waitForLeasePoll = waiter;
  return () => {
    if (waitForLeasePoll === waiter) waitForLeasePoll = previous;
  };
}

async function waitForOAuthRefreshLease(
  credentialId: string,
  expected: OAuthRefreshObservationSnapshot
): Promise<{ leaseId: string } | { result: OAuthRefreshResult }> {
  const deadline = getOAuthRefreshLeaseMonotonicTime() + REFRESH_LEASE_WAIT_MS;
  while (getOAuthRefreshLeaseMonotonicTime() < deadline) {
    const observed = observedRemoteRefresh(credentialId, expected);
    if (observed) return { result: observed };

    const acquisition = acquireOAuthRefreshLease(credentialId);
    if (acquisition.outcome === "acquired") return { leaseId: acquisition.leaseId };
    if (acquisition.outcome === "not-found") {
      return {
        result: { credentialId, outcome: "skipped", failureCode: "credential_not_found" },
      };
    }
    const remaining = deadline - getOAuthRefreshLeaseMonotonicTime();
    if (remaining <= 0) break;
    await waitForLeasePoll(Math.min(REFRESH_LEASE_POLL_MS, Math.max(1, remaining)));
  }

  const observed = observedRemoteRefresh(credentialId, expected);
  return observed
    ? { result: observed }
    : {
        result: {
          credentialId,
          outcome: "failed",
          terminal: false,
          failureCode: "oauth_refresh_lease_timeout",
        },
      };
}

function startOAuthRefreshLeaseHeartbeat(leaseId: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    renewOAuthRefreshLeaseSafely(leaseId);
  }, REFRESH_LEASE_RENEW_MS);
  timer.unref?.();
  return timer;
}

function renewOAuthRefreshLeaseSafely(leaseId: string): boolean {
  try {
    return renewOAuthRefreshLease(leaseId);
  } catch (error) {
    console.warn(
      "[oauth-refresh] lease renewal failed:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

function lostOAuthRefreshLeaseResult(
  credentialId: string,
  expected: OAuthRefreshObservationSnapshot
): OAuthRefreshResult {
  return (
    observedRemoteRefresh(credentialId, expected) ?? {
      credentialId,
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_refresh_lease_lost",
    }
  );
}

function assertOAuthRefreshLeaseHeld(leaseId: string): void {
  if (!isOAuthRefreshLeaseHeld(leaseId)) throw new OAuthRefreshLeaseLostError();
}

function markTerminalRefreshFailure(
  credentialId: string,
  type: string,
  data: OAuthCredentialData,
  error: OAuthTokenRequestError,
  now: number,
  expectedEncryptedData: string,
  leaseId: string,
  directApp?: DirectOAuthAppCredentialSnapshot
): string | null {
  const failureCode = failureCodeFor(error);
  return getDb()
    .transaction(() => {
      assertOAuthRefreshLeaseHeld(leaseId);
      if (directApp) assertDirectAppCredentialUnchanged(directApp);
      const row = getDb()
        .prepare("SELECT encrypted_data FROM credentials WHERE id = ?")
        .get(credentialId) as { encrypted_data: string } | undefined;
      if (!row || row.encrypted_data !== expectedEncryptedData) return null;
      const binding = ensureOAuthCredentialBinding(credentialId, type, data, now);
      updateIntegrationCredentialAuthState(binding, {
        authStatus: "reauthentication-required",
        failureCode,
      });
      return failureCode;
    })
    .immediate();
}

async function refreshOAuthCredentialOnce(
  credentialId: string,
  options: { force?: boolean; now?: number } = {}
): Promise<OAuthRefreshResult> {
  const now = options.now ?? Date.now();
  const stored = getCredentialData(credentialId);
  if (!stored) return { credentialId, outcome: "skipped", failureCode: "credential_not_found" };
  const data = stored.data as OAuthCredentialData;
  if (!isOAuthCredentialData(stored.cred.type, data)) {
    return { credentialId, outcome: "skipped", failureCode: "oauth_refresh_unavailable" };
  }
  const binding = ensureOAuthCredentialBinding(credentialId, stored.cred.type, data, now);
  if (!options.force && binding.authStatus === "reauthentication-required") {
    return {
      credentialId,
      outcome: "failed",
      terminal: true,
      failureCode: binding.failureCode ?? "oauth_refresh_unavailable",
    };
  }
  if (!data.refreshToken || !data.clientId) {
    if (binding.authStatus === "reauthentication-required") {
      return {
        credentialId,
        outcome: "failed",
        terminal: true,
        failureCode: binding.failureCode ?? "oauth_refresh_unavailable",
      };
    }
    return { credentialId, outcome: "skipped", failureCode: "oauth_refresh_unavailable" };
  }
  if (!options.force) {
    if (!data.expiresAt) return { credentialId, outcome: "skipped" };
    const expiry = Date.parse(data.expiresAt);
    if (Number.isFinite(expiry) && expiry - now > EXPIRY_THRESHOLD_MS) {
      return { credentialId, outcome: "skipped", expiresAt: data.expiresAt };
    }
  }

  const provider = getOAuthProviderConfigForCredential(data);
  if (!provider) {
    return { credentialId, outcome: "skipped", failureCode: "oauth_provider_unknown" };
  }

  const observation: OAuthRefreshObservationSnapshot = {
    encryptedData: stored.cred.encryptedData,
    credentialType: stored.cred.type,
    binding: {
      credentialId: binding.credentialId,
      integrationId: binding.integrationId,
      manifestCredentialId: binding.manifestCredentialId,
      manifestVersion: binding.manifestVersion,
    },
    tokens: oauthTokenTuple(data),
  };
  const lease = await waitForOAuthRefreshLease(credentialId, observation);
  if ("result" in lease) return lease.result;
  const heartbeat = startOAuthRefreshLeaseHeartbeat(lease.leaseId);
  let directApp: DirectOAuthAppCredentialSnapshot | null = null;
  try {
    const observed = observedRemoteRefresh(credentialId, observation);
    if (observed) return observed;

    assertSafeOAuthExtraParams(provider.extraTokenParams, "token");
    const isDirect = !usesSynthesizedOAuthMetadata(data) && !!getDirectOAuthProvider(provider.id);
    directApp = isDirect ? getDirectAppCredentialForToken(provider.id, data) : null;
    if (isDirect && (!directApp || (provider.requiresSecret && !directApp.clientSecret))) {
      return {
        credentialId,
        outcome: "skipped",
        failureCode: "oauth_app_credential_unavailable",
      };
    }
    if (isDirect && directApp) assertDirectAppCredentialUnchanged(directApp);
    const tokens = await refreshAccessToken(
      provider,
      data.refreshToken,
      data.clientId,
      isDirect ? directApp?.clientSecret : data.clientSecret
    );
    if (!renewOAuthRefreshLeaseSafely(lease.leaseId)) {
      return lostOAuthRefreshLeaseResult(credentialId, observation);
    }
    const refreshedScopes = tokens.scope ? splitScopes(tokens.scope) : binding.scopes;
    const refreshedScopeSet = new Set(refreshedScopes);
    const insufficientScope =
      !!tokens.scope && binding.scopes.some((scope) => !refreshedScopeSet.has(scope));
    const credentialPatch = {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokens.expiresAt ?? null,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(isDirect && directApp ? { oauthAppCredentialId: directApp.credentialId } : {}),
    };
    const commit = (expectedEncryptedData: string) =>
      updateCredentialDataIfUnchanged(credentialId, expectedEncryptedData, credentialPatch, () => {
        assertOAuthRefreshLeaseHeld(lease.leaseId);
        if (isDirect && directApp) assertDirectAppCredentialUnchanged(directApp);
        updateIntegrationCredentialAuthState(binding, {
          authStatus: insufficientScope ? "reauthentication-required" : "active",
          failureCode: insufficientScope ? "oauth_insufficient_scope" : null,
          tokenExpiresAt: tokens.expiresAt ?? null,
          scopes: refreshedScopes,
        });
      });
    let updated = commit(stored.cred.encryptedData);
    for (let attempt = 0; updated.outcome === "conflict" && attempt < 7; attempt += 1) {
      const current = getCredentialData(credentialId);
      const currentData = current?.data as OAuthCredentialData | undefined;
      if (
        !current ||
        !currentData ||
        current.cred.type !== stored.cred.type ||
        !sameOAuthTokenTuple(observation.tokens, oauthTokenTuple(currentData)) ||
        !sameOAuthBindingIdentity(
          observation.binding,
          getOAuthBindingIdentity(credentialId, current.cred.type, currentData)
        )
      ) {
        break;
      }
      updated = commit(current.cred.encryptedData);
    }
    if (updated.outcome !== "updated") {
      const observed = observedRemoteRefresh(credentialId, observation);
      if (updated.outcome === "conflict" && observed) return observed;
      return {
        credentialId,
        outcome: "failed",
        failureCode:
          updated.outcome === "not-found" ? "credential_not_found" : "credential_update_conflict",
      };
    }
    if (insufficientScope) {
      return {
        credentialId,
        outcome: "failed",
        terminal: true,
        failureCode: "oauth_insufficient_scope",
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      };
    }
    return {
      credentialId,
      outcome: "refreshed",
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    };
  } catch (error) {
    const classification = classifyOAuthProviderError(error);
    if (error instanceof OAuthRefreshLeaseLostError) {
      return lostOAuthRefreshLeaseResult(credentialId, observation);
    }
    if (error instanceof OAuthAppCredentialChangedError) {
      return {
        credentialId,
        outcome: "failed",
        terminal: false,
        failureCode: "oauth_app_credential_changed",
      };
    }
    if (error instanceof OAuthTokenRequestError && classification !== "retryable") {
      if (!renewOAuthRefreshLeaseSafely(lease.leaseId)) {
        return lostOAuthRefreshLeaseResult(credentialId, observation);
      }
      let failureCode: string | null;
      try {
        failureCode = markTerminalRefreshFailure(
          credentialId,
          stored.cred.type,
          data,
          error,
          now,
          stored.cred.encryptedData,
          lease.leaseId,
          directApp ?? undefined
        );
      } catch (markError) {
        if (markError instanceof OAuthRefreshLeaseLostError) {
          return lostOAuthRefreshLeaseResult(credentialId, observation);
        }
        if (markError instanceof OAuthAppCredentialChangedError) {
          return {
            credentialId,
            outcome: "failed",
            terminal: false,
            failureCode: "oauth_app_credential_changed",
          };
        }
        throw markError;
      }
      if (!failureCode) {
        const observed = observedRemoteRefresh(credentialId, observation);
        if (observed) return observed;
        return { credentialId, outcome: "skipped", failureCode: "oauth_refresh_superseded" };
      }
      return { credentialId, outcome: "failed", terminal: true, failureCode };
    }
    console.warn(
      "[oauth-refresh] refresh failed:",
      error instanceof Error ? error.message : String(error)
    );
    return {
      credentialId,
      outcome: "failed",
      terminal: false,
      failureCode: "oauth_refresh_failed",
    };
  } finally {
    clearInterval(heartbeat);
    try {
      releaseOAuthRefreshLease(lease.leaseId);
    } catch (error) {
      console.warn(
        "[oauth-refresh] lease release failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export function refreshOAuthCredential(
  credentialId: string,
  options: { force?: boolean; now?: number } = {}
): Promise<OAuthRefreshResult> {
  const active = refreshFlights.get(credentialId);
  if (active) return active;
  const flight = refreshOAuthCredentialOnce(credentialId, options).finally(() => {
    if (refreshFlights.get(credentialId) === flight) refreshFlights.delete(credentialId);
  });
  refreshFlights.set(credentialId, flight);
  return flight;
}

export async function runOAuthTokenRefreshCycle(now = Date.now()): Promise<OAuthRefreshResult[]> {
  const results: OAuthRefreshResult[] = [];
  for (const credential of listCredentialMetadata()) {
    if (DIRECT_OAUTH_APP_CREDENTIAL_TYPES.has(credential.type)) continue;
    const stored = getCredentialData(credential.id);
    const data = stored?.data as OAuthCredentialData | undefined;
    if (!stored || !data || !isOAuthCredentialData(credential.type, data)) continue;
    const result = await refreshOAuthCredential(credential.id, { now });
    results.push(result);
    if (result.outcome === "failed") {
      console.warn(
        `[oauth-refresh] failed ${credential.type}: ${result.failureCode ?? "oauth_refresh_failed"}`
      );
    }
  }
  return results;
}

export function startOAuthTokenRefresh(): void {
  if (intervalId) return;
  setTimeout(() => {
    runOAuthTokenRefreshCycle().catch(() =>
      console.warn("[oauth-refresh] startup refresh cycle failed")
    );
  }, 5_000);
  intervalId = setInterval(() => {
    runOAuthTokenRefreshCycle().catch(() =>
      console.warn("[oauth-refresh] periodic refresh cycle failed")
    );
  }, REFRESH_INTERVAL_MS);
  console.log("[oauth-refresh] token refresh scheduler started (every 30m)");
}

export function stopOAuthTokenRefresh(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
