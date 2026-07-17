import { Hono } from "hono";
import {
  createCredential,
  deleteCredential,
  getCredentialData,
  updateCredentialDataIfUnchanged,
  type CredentialDataPatch,
} from "../db/credential-store.ts";
import { getDb } from "../db/database.ts";
import {
  advanceIntegrationSetupFlow,
  createIntegrationSetupFlow,
  getIntegrationCredentialBinding,
  getIntegrationSetupFlow,
  hashIntegrationAccountFingerprint,
  putIntegrationSetupSecretEnvelope,
  setIntegrationSetupDuplicateCandidates,
  transitionIntegrationSetupFlow,
  upsertIntegrationCredentialBinding,
} from "../db/integration-setup-store.ts";
import {
  disconnectAccount as composioDisconnect,
  initiateConnection as composioInitiate,
} from "../lib/composio-client.ts";
import {
  assertSafeOAuthExtraParams,
  assertPendingOAuthFlowTargets,
  boundedOAuthMessage as boundedMessage,
  callbackHtml,
  classifyOAuthProviderError,
  consumePendingFlow,
  exchangeCode,
  generateAuthUrl,
  OAuthCredentialDriftError,
  OAuthDuplicateAccountError,
  preflightOAuthAccountChoice,
  safeOAuthCorrelationId as safeId,
  type OAuthProviderConfig,
  type OAuthCallbackCorrelation,
  type OAuthTokens,
  type PendingOAuthFlow,
} from "../lib/oauth-engine.ts";
import { getDirectOAuthProvider } from "../lib/oauth-providers.ts";
import {
  assertCredentialAuthUsable,
  CredentialReauthenticationRequiredError,
} from "../lib/integration-auth-gate.ts";
import {
  getComposioConnections,
  getLocalOAuthConnections,
} from "../lib/oauth-connection-listing.ts";
import { isOAuthCredentialData, refreshOAuthCredential } from "../lib/oauth-token-refresh.ts";
import { processBrokerCallback } from "../lib/oauth-broker-callback.ts";
import { brokerCorrelationPayload } from "../lib/oauth-broker-correlation.ts";
import { markOAuthAppCredentialRepairRequired } from "../lib/oauth-app-credential-repair.ts";
import {
  directAppCredentials,
  getClientSecretForProvider,
  hasComposioKey,
  oauthCallbackOrigin,
  oauthPostMessageOrigin,
  OAuthInsufficientScopeError,
  selectDirectOAuthCredentials,
  validatedGrantedScopes,
} from "../lib/oauth-route-helpers.ts";
import {
  assertActiveManifestOAuthFlow,
  assertBrokerManifestOAuthAttempt,
  assertDirectManifestOAuthAttempt,
  assertManifestOAuthCredentialTarget,
  assertSynthesizedManifestOAuthAttempt,
  resolveJournaledOAuthCredentialId,
  OAuthManifestMismatchError,
  type ValidatedManifestOAuthAttempt,
} from "../lib/oauth-manifest-validator.ts";
import type {
  DirectOAuthInitiate,
  OAuthCredentialData,
  OAuthFlowReference,
  SynthesizedOAuthInitiate,
} from "../lib/oauth-route-types.ts";
import { OAUTH_PROVIDERS } from "../lib/provider-registry.ts";
import { assertSafeUrl } from "../lib/url-safety.ts";

const oauth = new Hono();
const PORT = Number(process.env.PORT ?? 9147);
const CALLBACK_URL =
  process.env.OAUTH_CALLBACK_URL ?? `http://localhost:${PORT}/api/oauth/callback`;
const LEGACY_MANIFEST_VERSION = "0.0.0";

type CallbackCorrelation = OAuthCallbackCorrelation;

class OAuthFlowInactiveError extends Error {}
class OAuthAccountIdentityMismatchError extends Error {}

function requireAwaitingOAuthFlow(flowId: string) {
  const flow = getIntegrationSetupFlow(flowId);
  if (!flow || flow.status !== "awaiting-oauth" || Date.parse(flow.expiresAt) <= Date.now()) {
    throw new OAuthFlowInactiveError("OAuth setup is no longer active");
  }
  const active = flow.steps.find((step) => step.status === "active");
  if ((flow.steps.length > 0 && !active) || (active && active.kind !== "oauth")) {
    throw new OAuthFlowInactiveError("OAuth setup has no active OAuth step");
  }
  return flow;
}

function requireManifestOAuthFlow(flowId: string) {
  const flow = requireAwaitingOAuthFlow(flowId);
  const active = flow.steps.find((step) => step.status === "active");
  if (!active || active.kind !== "oauth") {
    throw new OAuthFlowInactiveError("Manifest setup has no active OAuth step");
  }
  return flow;
}

function callbackUrlForFlow(flowId: string): string {
  const url = new URL(CALLBACK_URL);
  url.searchParams.set("flowId", flowId);
  return url.toString();
}

function createLegacyBrokerFlow(providerId: string) {
  let flow = createIntegrationSetupFlow({
    integrationId: `oauth.${providerId}`,
    manifestVersion: LEGACY_MANIFEST_VERSION,
    manifestCredentialId: "oauth.broker",
    credentialType: `oauth-broker-${providerId}`,
    mode: "setup",
  });
  flow = transitionIntegrationSetupFlow(flow.id, flow.revision, { status: "awaiting-oauth" });
  return flow;
}

function oauthOptions(
  body: OAuthFlowReference,
  credentials: { targetCredentialId?: string; oauthCredentialId?: string } = {}
) {
  return {
    ...(body.flowId ? { flowId: body.flowId } : {}),
    ...(body.integrationId ? { integrationId: body.integrationId } : {}),
    ...(body.manifestVersion ? { manifestVersion: body.manifestVersion } : {}),
    ...(body.manifestCredentialId ? { manifestCredentialId: body.manifestCredentialId } : {}),
    ...(credentials.targetCredentialId
      ? { targetCredentialId: credentials.targetCredentialId }
      : {}),
    ...(credentials.oauthCredentialId ? { oauthCredentialId: credentials.oauthCredentialId } : {}),
  };
}

function completeDurableOAuthFlow(flowId: string, oauthCredentialId?: string): void {
  let flow = requireAwaitingOAuthFlow(flowId);
  const active = flow.steps.find((step) => step.status === "active");
  if (flow.duplicateCandidates.length > 0) {
    flow = setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, []);
  }
  flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
    authStatus: "active",
    failureCode: null,
    oauthCreateAdditional: false,
    ...(oauthCredentialId ? { oauthCredentialId } : {}),
  });
  if (active?.kind === "oauth") {
    advanceIntegrationSetupFlow(flow.id, flow.revision);
  } else if (!active) {
    transitionIntegrationSetupFlow(flow.id, flow.revision, { status: "completed" });
  }
}

function transitionDurableOAuthFlowToFailure(flowId: string, failureCode: string): void {
  const flow = getIntegrationSetupFlow(flowId);
  if (!flow || ["completed", "failed", "cancelled", "expired"].includes(flow.status)) return;
  const active = flow.steps.find((step) => step.status === "active");
  transitionIntegrationSetupFlow(flow.id, flow.revision, {
    status: "failed",
    authStatus: "failed",
    failureCode,
    ...(active ? { step: { id: active.id, status: "failed" as const, failureCode } } : {}),
  });
}

function failDurableOAuthFlow(flowId: string, failureCode: string): void {
  try {
    transitionDurableOAuthFlowToFailure(flowId, failureCode);
  } catch {
    // A concurrent cancellation/expiry already made the flow terminal.
  }
}

function tokenCredentialPatch(
  pending: PendingOAuthFlow,
  provider: OAuthProviderConfig,
  tokens: OAuthTokens,
  flow: NonNullable<ReturnType<typeof getIntegrationSetupFlow>>
): CredentialDataPatch {
  const synthesized = !!pending.inlineProvider;
  return {
    accessToken: tokens.accessToken,
    provider: pending.providerId,
    clientId: pending.clientId,
    oauthKind: synthesized ? "synthesized" : "direct",
    oauthIntegrationId: flow.integrationId,
    oauthManifestVersion: flow.manifestVersion,
    oauthManifestCredentialId: pending.oauthManifestCredentialId,
    ...(pending.appCredentialId ? { oauthAppCredentialId: pending.appCredentialId } : {}),
    expiresAt: tokens.expiresAt ?? null,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(synthesized
      ? {
          ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
          tokenUrl: provider.tokenUrl,
          authUrl: provider.authUrl,
          oauthProviderName: pending.inlineProviderName ?? provider.name,
          scopes: provider.scopes.join(" "),
          ...(provider.extraTokenParams
            ? { extraTokenParams: JSON.stringify(provider.extraTokenParams) }
            : {}),
        }
      : {}),
  };
}

function oauthTokenTargetId(
  flow: NonNullable<ReturnType<typeof getIntegrationSetupFlow>>
): string | undefined {
  return flow.oauthCredentialId;
}

function oauthDecisionRequired(flow: NonNullable<ReturnType<typeof getIntegrationSetupFlow>>) {
  return {
    error: "Choose how to handle an existing OAuth account before authorization.",
    code: "oauth_account_decision_required",
    flowId: flow.id,
    duplicateCandidates: flow.duplicateCandidates,
  };
}

function matchingAccountBindingIds(
  integrationId: string,
  manifestCredentialId: string,
  accountFingerprint: string,
  credentialType: string,
  targetCredentialId?: string
): string[] {
  const rows = getDb()
    .prepare(
      `SELECT b.credential_id FROM integration_credential_bindings b
       JOIN credentials c ON c.id = b.credential_id
       WHERE b.integration_id = ? AND b.manifest_credential_id = ?
         AND b.account_fingerprint = ? AND c.type = ?
         AND b.auth_method IN ('oauth', 'oauth2')
       ORDER BY b.credential_id LIMIT 256`
    )
    .all(integrationId, manifestCredentialId, accountFingerprint, credentialType) as Array<{
    credential_id: string;
  }>;
  return rows
    .map((row) => row.credential_id)
    .filter((credentialId) => credentialId !== targetCredentialId);
}

function saveOAuthCredential(
  pending: PendingOAuthFlow,
  provider: OAuthProviderConfig,
  tokens: OAuthTokens
): string {
  const grantedScopes = validatedGrantedScopes(tokens, provider.scopes);
  const result = getDb()
    .transaction(() => {
      const flow = requireAwaitingOAuthFlow(pending.flowId);
      assertActiveManifestOAuthFlow(pending.flowId);
      assertPendingOAuthFlowTargets(pending);
      if (pending.appCredentialId) assertCredentialAuthUsable(pending.appCredentialId);
      const patch = tokenCredentialPatch(pending, provider, tokens, flow);
      const bindingManifestCredentialId = patch.oauthManifestCredentialId;
      if (typeof bindingManifestCredentialId !== "string") {
        throw new TypeError("OAuth manifest credential binding is invalid");
      }
      const targetCredentialId = oauthTokenTargetId(flow);
      const accountFingerprintSource = tokens.accountIdentity
        ? `${tokens.accountIdentity.source}:${tokens.accountIdentity.value}`
        : undefined;
      const targetBinding = targetCredentialId
        ? getIntegrationCredentialBinding({
            credentialId: targetCredentialId,
            integrationId: flow.integrationId,
            manifestCredentialId: bindingManifestCredentialId,
          })
        : null;
      if (targetBinding?.accountFingerprint) {
        const receivedFingerprint = accountFingerprintSource
          ? hashIntegrationAccountFingerprint(flow.integrationId, accountFingerprintSource)
          : undefined;
        if (!receivedFingerprint || receivedFingerprint !== targetBinding.accountFingerprint) {
          throw new OAuthAccountIdentityMismatchError(
            "OAuth authorization returned a different or unverifiable account identity"
          );
        }
      }
      if (accountFingerprintSource && !flow.oauthCreateAdditional) {
        const accountFingerprint = hashIntegrationAccountFingerprint(
          flow.integrationId,
          accountFingerprintSource
        );
        const duplicates = matchingAccountBindingIds(
          flow.integrationId,
          bindingManifestCredentialId,
          accountFingerprint,
          pending.credentialType,
          targetCredentialId
        );
        if (duplicates.length > 0) {
          const withCandidates = setIntegrationSetupDuplicateCandidates(
            flow.id,
            flow.revision,
            duplicates
          );
          transitionIntegrationSetupFlow(withCandidates.id, withCandidates.revision, {
            status: "awaiting-confirmation",
            failureCode: null,
            oauthCreateAdditional: false,
          });
          return { duplicateIds: duplicates } as const;
        }
      }

      requireAwaitingOAuthFlow(flow.id);
      const target = targetCredentialId ? getCredentialData(targetCredentialId) : null;
      if (targetCredentialId && (!target || target.cred.type !== pending.credentialType)) {
        throw new TypeError("OAuth account target is no longer available");
      }
      let credentialId: string;
      if (target?.cred.type === pending.credentialType) {
        requireAwaitingOAuthFlow(flow.id);
        if (!pending.oauthCredentialEncryptedData) {
          throw new OAuthCredentialDriftError("OAuth target credential snapshot is missing");
        }
        const updated = updateCredentialDataIfUnchanged(
          target.cred.id,
          pending.oauthCredentialEncryptedData,
          patch
        );
        if (updated.outcome !== "updated") {
          throw new OAuthCredentialDriftError(
            "OAuth target credential changed during authorization"
          );
        }
        credentialId = target.cred.id;
      } else {
        const friendlyName =
          pending.inlineProviderName ??
          OAUTH_PROVIDERS.find((item) => item.id === pending.providerId)?.name ??
          pending.providerId;
        const createData = Object.fromEntries(
          Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== null)
        );
        requireAwaitingOAuthFlow(flow.id);
        credentialId = createCredential(
          `${friendlyName} (OAuth)`,
          pending.credentialType,
          createData
        ).id;
      }
      requireAwaitingOAuthFlow(flow.id);
      upsertIntegrationCredentialBinding({
        credentialId,
        integrationId: flow.integrationId,
        manifestVersion: flow.manifestVersion,
        manifestCredentialId: bindingManifestCredentialId,
        authMethod: "oauth2",
        authStatus: "active",
        tokenExpiresAt: tokens.expiresAt ?? null,
        scopes: grantedScopes,
        ...(accountFingerprintSource ? { accountFingerprintSource } : {}),
        ...(tokens.accountIdentity?.label ? { accountLabel: tokens.accountIdentity.label } : {}),
      });
      requireAwaitingOAuthFlow(flow.id);
      completeDurableOAuthFlow(flow.id, credentialId);
      return { credentialId } as const;
    })
    .immediate();
  if ("duplicateIds" in result && result.duplicateIds) {
    throw new OAuthDuplicateAccountError(result.duplicateIds);
  }
  return result.credentialId;
}

oauth.get("/providers", async (c) => {
  const local = getLocalOAuthConnections();
  const composio = await getComposioConnections();
  const connections = [...local, ...composio];
  const providers = OAUTH_PROVIDERS.map((provider) => ({
    ...provider,
    connected: connections.some(
      (connection) => connection.platform === provider.id && connection.status === "active"
    ),
    needsReauthentication: local.some(
      (connection) => connection.platform === provider.id && connection.needsReauthentication
    ),
    hasSetupCredentials:
      provider.method === "direct" ? directAppCredentials(provider).length > 0 : hasComposioKey(),
  }));
  return c.json({ data: { providers, connections, hasComposioKey: hasComposioKey() } });
});

oauth.post("/initiate", async (c) => {
  let body: DirectOAuthInitiate;
  try {
    body = await c.req.json<DirectOAuthInitiate>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const provider = OAUTH_PROVIDERS.find((item) => item.id === body.provider);
  if (!provider) return c.json({ error: `Unknown OAuth provider: ${body.provider}` }, 400);

  if (provider.method === "composio") {
    if (!hasComposioKey()) {
      return c.json(
        { error: "Composio API key required. Add it in Settings > Integrations." },
        400
      );
    }
    let flow;
    try {
      flow = body.flowId
        ? requireManifestOAuthFlow(body.flowId)
        : createLegacyBrokerFlow(provider.id);
      assertBrokerManifestOAuthAttempt(body.flowId, provider.id);
    } catch {
      return c.json({ error: "OAuth setup flow is not ready for broker authorization." }, 400);
    }
    try {
      const openerOrigin = oauthPostMessageOrigin(CALLBACK_URL);
      const result = await composioInitiate(provider.composioToolkit!, callbackUrlForFlow(flow.id));
      requireAwaitingOAuthFlow(flow.id);
      if (!safeId(result.connectedAccountId)) {
        throw new TypeError("Broker connection ID was invalid");
      }
      putIntegrationSetupSecretEnvelope({
        flowId: flow.id,
        purpose: "staged-oauth",
        state: result.connectedAccountId,
        payload: brokerCorrelationPayload({
          schemaVersion: 1,
          flowId: flow.id,
          connectionId: result.connectedAccountId,
          providerId: provider.id,
          postMessageOrigin: openerOrigin,
        }),
      });
      return c.json({
        data: {
          redirectUrl: result.redirectUrl,
          connectionId: result.connectedAccountId,
          flowId: flow.id,
          callbackOrigin: oauthCallbackOrigin(CALLBACK_URL),
          method: "composio",
        },
      });
    } catch {
      return c.json({ error: "Composio could not start the OAuth connection." }, 502);
    }
  }

  const direct = getDirectOAuthProvider(body.provider);
  if (!direct) return c.json({ error: `No direct OAuth config for: ${body.provider}` }, 400);
  if (!body.flowId && (body.oauthCredentialId || body.targetCredentialId)) {
    return c.json(
      {
        error: "Direct OAuth reauthentication requires an active manifest setup flow.",
        code: "oauth_manifest_reauthentication_required",
      },
      400
    );
  }
  let oauthCredentialId: string | undefined;
  try {
    oauthCredentialId = resolveJournaledOAuthCredentialId(body);
  } catch {
    return c.json({ error: "OAuth account credential references do not match." }, 400);
  }
  const appSelection = selectDirectOAuthCredentials(provider, body, oauthCredentialId);
  if (!("selected" in appSelection)) {
    if (appSelection.candidateIds.length > 1) {
      return c.json(
        {
          error: "Multiple OAuth app credentials are available. Select one explicitly.",
          code: "oauth_app_credential_selection_required",
          needsAppCredentialSelection: true,
          candidateCredentialIds: appSelection.candidateIds,
        },
        409
      );
    }
    return c.json(
      {
        error: `No ${provider.name} app credentials configured. Add your Client ID${direct.requiresSecret ? " and Client Secret" : ""} first.`,
        needsSetup: true,
        setupCredentialType: provider.setupCredentialType,
      },
      400
    );
  }
  const appCredentials = appSelection.selected;
  let oauthCredentialEncryptedData: string | undefined;
  if (oauthCredentialId) {
    const target = getCredentialData(oauthCredentialId);
    if (!target || target.cred.type !== `oauth-token-${body.provider}`) {
      return c.json({ error: "Target OAuth credential is invalid." }, 400);
    }
    oauthCredentialEncryptedData = target.cred.encryptedData;
  }
  try {
    const openerOrigin = oauthPostMessageOrigin(CALLBACK_URL);
    const manifestAttempt = assertDirectManifestOAuthAttempt(
      body.flowId,
      { ...direct, networkMode: "builtin" },
      appCredentials.credentialId,
      appCredentials.clientId,
      appCredentials.clientSecret
    );
    const outputCredentialType = `oauth-token-${body.provider}`;
    const manifestOAuthId = manifestAttempt?.manifestOAuthId ?? "oauth.direct";
    assertManifestOAuthCredentialTarget(
      body.flowId,
      oauthCredentialId,
      outputCredentialType,
      manifestOAuthId
    );
    const directPreflight = preflightOAuthAccountChoice(
      body.flowId,
      outputCredentialType,
      manifestOAuthId
    );
    if (directPreflight.paused) {
      return c.json(oauthDecisionRequired(directPreflight.paused), 409);
    }
    const generated = generateAuthUrl(
      { ...direct, networkMode: "builtin" },
      appCredentials.clientId,
      appCredentials.clientSecret,
      CALLBACK_URL,
      {
        ...oauthOptions(body, {
          targetCredentialId: appCredentials.credentialId,
          oauthCredentialId,
        }),
        credentialType: outputCredentialType,
        appCredentialId: appCredentials.credentialId,
        appCredentialType: appCredentials.credentialType,
        appCredentialEncryptedData: appCredentials.encryptedData,
        ...(oauthCredentialEncryptedData ? { oauthCredentialEncryptedData } : {}),
        oauthManifestCredentialId: manifestOAuthId,
        postMessageOrigin: openerOrigin,
      }
    );
    return c.json({
      data: {
        redirectUrl: generated.authUrl,
        connectionId: generated.state,
        flowId: generated.flowId,
        expiresAt: generated.expiresAt,
        callbackOrigin: oauthCallbackOrigin(CALLBACK_URL),
        ...(oauthCredentialId ? { oauthCredentialId } : {}),
        method: "direct",
      },
    });
  } catch {
    return c.json({ error: "OAuth setup flow could not be started." }, 400);
  }
});

oauth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const providerError = c.req.query("error");
  const composioStatus = c.req.query("status");
  if (composioStatus) {
    const result = await processBrokerCallback({
      connectionId: c.req.query("connectedAccountId") ?? c.req.query("connectionId"),
      requestedFlowId: c.req.query("flowId"),
      validateFlow: (flowId, providerId) => {
        requireAwaitingOAuthFlow(flowId);
        assertBrokerManifestOAuthAttempt(flowId, providerId);
      },
      completeFlow: (flowId, providerId) => {
        requireAwaitingOAuthFlow(flowId);
        assertBrokerManifestOAuthAttempt(flowId, providerId);
        completeDurableOAuthFlow(flowId);
      },
    });
    return c.html(
      callbackHtml(
        result.success,
        result.message,
        { flowId: result.flowId, connectionId: result.connectionId, errorCode: result.errorCode },
        result.postMessageOrigin
      )
    );
  }
  if (providerError) {
    const pending = state ? consumePendingFlow(state) : undefined;
    const classification = classifyOAuthProviderError(providerError);
    const failureCode =
      classification === "app-configuration"
        ? "oauth_app_configuration_error"
        : classification === "denial-or-account"
          ? "oauth_authorization_denied"
          : undefined;
    if (pending && classification === "app-configuration") {
      markOAuthAppCredentialRepairRequired(pending);
    }
    if (pending && failureCode) failDurableOAuthFlow(pending.flowId, failureCode);
    return c.html(
      callbackHtml(
        false,
        `OAuth error: ${boundedMessage(providerError, "authorization failed")}`,
        {
          flowId: pending?.flowId,
          connectionId: safeId(state),
          errorCode: failureCode ?? "oauth_provider_retryable",
        },
        pending?.postMessageOrigin
      )
    );
  }
  if (!code || !state) {
    return c.html(callbackHtml(false, "Missing authorization code or state parameter."));
  }

  const pending = consumePendingFlow(state);
  if (!pending) {
    return c.html(
      callbackHtml(false, "OAuth session expired or was already used. Please try again.")
    );
  }
  const correlation: CallbackCorrelation = {
    flowId: pending.flowId,
    connectionId: state,
  };
  const provider = pending.inlineProvider ?? getDirectOAuthProvider(pending.providerId);
  if (!provider) {
    failDurableOAuthFlow(pending.flowId, "oauth_provider_unknown");
    return c.html(
      callbackHtml(
        false,
        "OAuth provider is no longer available.",
        correlation,
        pending.postMessageOrigin
      )
    );
  }
  try {
    requireAwaitingOAuthFlow(pending.flowId);
    assertActiveManifestOAuthFlow(pending.flowId);
    assertPendingOAuthFlowTargets(pending);
    if (pending.appCredentialId) assertCredentialAuthUsable(pending.appCredentialId);
    const tokens = await exchangeCode(provider, code, pending);
    requireAwaitingOAuthFlow(pending.flowId);
    if (pending.appCredentialId) assertCredentialAuthUsable(pending.appCredentialId);
    const credentialId = saveOAuthCredential(pending, provider, tokens);
    return c.html(
      callbackHtml(
        true,
        "Account Connected!",
        {
          ...correlation,
          credentialId,
        },
        pending.postMessageOrigin
      )
    );
  } catch (error) {
    if (error instanceof CredentialReauthenticationRequiredError) {
      failDurableOAuthFlow(pending.flowId, "oauth_app_credential_unavailable");
      return c.html(
        callbackHtml(
          false,
          "OAuth app credentials require repair before authorization can continue.",
          { ...correlation, errorCode: "oauth_app_credential_unavailable" },
          pending.postMessageOrigin
        )
      );
    }
    if (error instanceof OAuthDuplicateAccountError) {
      return c.html(
        callbackHtml(
          false,
          "This OAuth account is already connected. Choose it explicitly.",
          {
            ...correlation,
            errorCode: "oauth_duplicate_account",
            duplicateCandidateIds: error.candidateIds,
          },
          pending.postMessageOrigin
        )
      );
    }
    if (error instanceof OAuthCredentialDriftError) {
      return c.html(
        callbackHtml(
          false,
          "OAuth credentials changed during authorization. Start a fresh connection attempt.",
          { ...correlation, errorCode: "oauth_credential_changed" },
          pending.postMessageOrigin
        )
      );
    }
    if (error instanceof OAuthAccountIdentityMismatchError) {
      return c.html(
        callbackHtml(
          false,
          "OAuth returned a different account. Sign in with the account selected for reauthentication.",
          { ...correlation, errorCode: "oauth_account_mismatch" },
          pending.postMessageOrigin
        )
      );
    }
    if (error instanceof OAuthInsufficientScopeError) {
      failDurableOAuthFlow(pending.flowId, "oauth_insufficient_scope");
      return c.html(
        callbackHtml(
          false,
          "OAuth authorization did not grant every required scope.",
          { ...correlation, errorCode: "oauth_insufficient_scope" },
          pending.postMessageOrigin
        )
      );
    }
    if (error instanceof OAuthManifestMismatchError) {
      return c.html(
        callbackHtml(
          false,
          "The integration manifest changed during authorization. Start a fresh setup attempt.",
          { ...correlation, errorCode: "oauth_manifest_changed" },
          pending.postMessageOrigin
        )
      );
    }
    if (error instanceof OAuthFlowInactiveError) {
      return c.html(
        callbackHtml(
          false,
          "OAuth setup is no longer active.",
          {
            ...correlation,
            errorCode: "oauth_flow_inactive",
          },
          pending.postMessageOrigin
        )
      );
    }
    const classification = classifyOAuthProviderError(error);
    const failureCode =
      classification === "app-configuration"
        ? "oauth_app_configuration_error"
        : classification === "denial-or-account"
          ? "oauth_authorization_denied"
          : undefined;
    if (classification === "app-configuration") markOAuthAppCredentialRepairRequired(pending);
    if (failureCode) failDurableOAuthFlow(pending.flowId, failureCode);
    return c.html(
      callbackHtml(
        false,
        "Token exchange failed. Please retry in Chvor.",
        {
          ...correlation,
          errorCode: failureCode ?? "oauth_provider_retryable",
        },
        pending.postMessageOrigin
      )
    );
  }
});

oauth.get("/connections", async (c) => {
  return c.json({ data: [...getLocalOAuthConnections(), ...(await getComposioConnections())] });
});

oauth.delete("/connections/:id", async (c) => {
  const id = c.req.param("id");
  const local = getCredentialData(id);
  if (local && isOAuthCredentialData(local.cred.type, local.data as OAuthCredentialData)) {
    deleteCredential(id);
    return c.json({ data: { disconnected: true, method: "direct" } });
  }
  if (hasComposioKey()) {
    try {
      await composioDisconnect(id);
      return c.json({ data: { disconnected: true, method: "composio" } });
    } catch {
      return c.json({ error: "Composio could not disconnect the account." }, 502);
    }
  }
  return c.json({ error: "Connection not found" }, 404);
});

oauth.post("/refresh/:credentialId", async (c) => {
  const credentialId = c.req.param("credentialId");
  if (!getCredentialData(credentialId)) return c.json({ error: "Credential not found" }, 404);
  const result = await refreshOAuthCredential(credentialId, { force: true });
  if (result.outcome === "refreshed") {
    return c.json({
      data: {
        refreshed: true,
        expiresAt: result.expiresAt ?? null,
        authStatus: "active",
      },
    });
  }
  if (result.terminal) {
    return c.json(
      {
        error: "OAuth authorization is no longer valid. Reauthenticate this account.",
        code: result.failureCode,
        needsReauthentication: true,
        credentialId,
      },
      422
    );
  }
  return c.json(
    {
      error:
        result.outcome === "skipped"
          ? "No usable OAuth refresh configuration is available."
          : "OAuth provider refresh failed. Try again.",
      code: result.failureCode,
    },
    result.outcome === "skipped" ? 400 : 502
  );
});

oauth.get("/synthesized/redirect-url", (c) => {
  return c.json({
    data: { redirectUrl: CALLBACK_URL, callbackOrigin: oauthCallbackOrigin(CALLBACK_URL) },
  });
});

oauth.post("/synthesized/initiate", async (c) => {
  let body: SynthesizedOAuthInitiate;
  try {
    body = await c.req.json<SynthesizedOAuthInitiate>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const credentialType = String(body.credentialType ?? "").trim();
  const providerName = String(body.providerName ?? "").trim();
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = body.clientSecret ? String(body.clientSecret).trim() : undefined;
  const authUrl = String(body.authUrl ?? "").trim();
  const tokenUrl = String(body.tokenUrl ?? "").trim();
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.map((scope) => String(scope).trim()).filter(Boolean)
    : [];
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(credentialType)) {
    return c.json(
      { error: "credentialType must be lowercase alphanumeric/hyphen (e.g. 'quickbooks')" },
      400
    );
  }
  if (!providerName || providerName.length > 200)
    return c.json({ error: "providerName is required" }, 400);
  if (!clientId || clientId.length > 65_536) return c.json({ error: "clientId is required" }, 400);
  if (!authUrl) return c.json({ error: "authUrl is required" }, 400);
  if (!tokenUrl) return c.json({ error: "tokenUrl is required" }, 400);
  if (scopes.length > 128 || scopes.some((scope) => scope.length > 1_024)) {
    return c.json({ error: "OAuth scopes exceed supported limits" }, 400);
  }
  try {
    assertSafeOAuthExtraParams(body.extraAuthParams, "authorization");
    assertSafeOAuthExtraParams(body.extraTokenParams, "token");
    assertSafeUrl(authUrl, "authUrl");
    assertSafeUrl(tokenUrl, "tokenUrl");
  } catch (error) {
    return c.json(
      {
        error: boundedMessage(error instanceof Error ? error.message : error, "Invalid OAuth URL"),
      },
      400
    );
  }
  if (!authUrl.startsWith("https://")) return c.json({ error: "authUrl must be https://" }, 400);
  if (!tokenUrl.startsWith("https://")) return c.json({ error: "tokenUrl must be https://" }, 400);
  let oauthCredentialId: string | undefined;
  try {
    oauthCredentialId = resolveJournaledOAuthCredentialId(body);
  } catch {
    return c.json({ error: "OAuth account credential references do not match." }, 400);
  }
  let oauthCredentialEncryptedData: string | undefined;
  if (oauthCredentialId) {
    const target = getCredentialData(oauthCredentialId);
    if (!target || target.cred.type !== credentialType) {
      return c.json({ error: "Target OAuth credential is invalid." }, 400);
    }
    oauthCredentialEncryptedData = target.cred.encryptedData;
  }
  const inlineProvider: OAuthProviderConfig = {
    id: credentialType,
    name: providerName,
    authUrl,
    tokenUrl,
    scopes,
    extraAuthParams: body.extraAuthParams,
    extraTokenParams: body.extraTokenParams,
    requiresSecret: !!clientSecret,
    networkMode: "synthesized",
  };
  let manifestAttempt: ValidatedManifestOAuthAttempt | null;
  try {
    manifestAttempt = assertSynthesizedManifestOAuthAttempt(
      body.flowId,
      inlineProvider,
      clientId,
      clientSecret,
      credentialType
    );
    assertManifestOAuthCredentialTarget(
      body.flowId,
      oauthCredentialId,
      manifestAttempt?.outputCredentialType ?? credentialType,
      manifestAttempt?.manifestOAuthId ?? "oauth.synthesized"
    );
  } catch {
    return c.json({ error: "OAuth setup flow could not be started." }, 400);
  }
  const synthesizedPreflight = preflightOAuthAccountChoice(
    body.flowId,
    manifestAttempt?.outputCredentialType ?? credentialType,
    manifestAttempt?.manifestOAuthId ?? "oauth.synthesized"
  );
  if (synthesizedPreflight.paused) {
    return c.json(oauthDecisionRequired(synthesizedPreflight.paused), 409);
  }
  try {
    const openerOrigin = oauthPostMessageOrigin(CALLBACK_URL);
    const appCredential = manifestAttempt?.appCredentialId
      ? getCredentialData(manifestAttempt.appCredentialId)
      : null;
    if (manifestAttempt?.appCredentialId && !appCredential) {
      throw new OAuthCredentialDriftError("OAuth app credential is no longer available");
    }
    const generated = generateAuthUrl(inlineProvider, clientId, clientSecret, CALLBACK_URL, {
      ...oauthOptions(body, { oauthCredentialId }),
      integrationId: body.integrationId ?? `oauth.${credentialType}`,
      manifestCredentialId: body.manifestCredentialId ?? "oauth.synthesized",
      inlineProvider,
      inlineProviderName: providerName,
      credentialType: manifestAttempt?.outputCredentialType ?? credentialType,
      ...(manifestAttempt ? { appCredentialId: manifestAttempt.appCredentialId } : {}),
      ...(appCredential
        ? {
            appCredentialType: appCredential.cred.type,
            appCredentialEncryptedData: appCredential.cred.encryptedData,
          }
        : {}),
      ...(oauthCredentialEncryptedData ? { oauthCredentialEncryptedData } : {}),
      oauthManifestCredentialId: manifestAttempt?.manifestOAuthId ?? "oauth.synthesized",
      postMessageOrigin: openerOrigin,
    });
    return c.json({
      data: {
        redirectUrl: generated.authUrl,
        connectionId: generated.state,
        flowId: generated.flowId,
        expiresAt: generated.expiresAt,
        callbackOrigin: oauthCallbackOrigin(CALLBACK_URL),
        ...(oauthCredentialId ? { oauthCredentialId } : {}),
        method: "synthesized" as const,
        redirectUriUsed: CALLBACK_URL,
      },
    });
  } catch {
    return c.json({ error: "OAuth setup flow could not be started." }, 400);
  }
});

export { callbackHtml, getClientSecretForProvider };
export default oauth;
