import { getCredentialData } from "../db/credential-store.ts";
import { getDb } from "../db/database.ts";
import { getIntegrationSetupFlow } from "../db/integration-setup-store.ts";
import { getActiveIntegrationManifest } from "./integration-manifest-catalog.ts";
import type { OAuthProviderConfig } from "./oauth-engine.ts";
import type { OAuthFlowReference } from "./oauth-route-types.ts";

const LEGACY_MANIFEST_VERSION = "0.0.0";

export class OAuthManifestMismatchError extends Error {}

export interface ValidatedManifestOAuthAttempt {
  manifestOAuthId: string;
  outputCredentialType: string;
  appCredentialId: string;
}

function isManifestBoundFlow(
  flow: NonNullable<ReturnType<typeof getIntegrationSetupFlow>>
): boolean {
  return flow.manifestVersion !== LEGACY_MANIFEST_VERSION || flow.steps.length > 0;
}

/** Resolve only an account target already journaled by manifest setup decisions. */
export function resolveJournaledOAuthCredentialId(body: OAuthFlowReference): string | undefined {
  if (!body.flowId) {
    if (
      body.oauthCredentialId &&
      body.targetCredentialId &&
      body.oauthCredentialId !== body.targetCredentialId
    ) {
      throw new OAuthManifestMismatchError("OAuth account credential references do not match");
    }
    return body.oauthCredentialId ?? body.targetCredentialId;
  }
  const flow = getIntegrationSetupFlow(body.flowId);
  if (!flow) throw new OAuthManifestMismatchError("OAuth setup flow was not found");
  if (!isManifestBoundFlow(flow)) return body.oauthCredentialId ?? body.targetCredentialId;
  if (
    (body.targetCredentialId !== undefined &&
      body.targetCredentialId !== flow.targetCredentialId) ||
    (body.oauthCredentialId !== undefined && body.oauthCredentialId !== flow.oauthCredentialId)
  ) {
    throw new OAuthManifestMismatchError("OAuth credential target was not journaled by setup");
  }
  return flow.oauthCredentialId;
}

function activeManifestOAuth(flowId: string | undefined) {
  if (!flowId) return null;
  const flow = getIntegrationSetupFlow(flowId);
  if (!flow) throw new OAuthManifestMismatchError("OAuth setup flow was not found");
  if (flow.manifestVersion === LEGACY_MANIFEST_VERSION && flow.steps.length === 0) return null;
  const active = flow.steps.find((step) => step.status === "active");
  const manifest = getActiveIntegrationManifest(flow.integrationId);
  if (!manifest || manifest.version !== flow.manifestVersion || active?.kind !== "oauth") {
    throw new OAuthManifestMismatchError("OAuth setup no longer matches the active manifest");
  }
  const setup = manifest.setup.find((step) => step.id === active.id);
  if (!setup || setup.kind !== "oauth") {
    throw new OAuthManifestMismatchError("OAuth setup step is not declared by the active manifest");
  }
  const declaration = manifest.oauth.find((item) => item.id === setup.oauthId);
  if (!declaration) {
    throw new OAuthManifestMismatchError("OAuth declaration is missing from the active manifest");
  }
  return { flow, manifest, declaration };
}

/** Revalidate a pending callback against the currently active manifest/step. */
export function assertActiveManifestOAuthFlow(flowId: string): void {
  activeManifestOAuth(flowId);
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  const expected = [...left].sort();
  const actual = [...right].sort();
  return (
    expected.length === actual.length && expected.every((scope, index) => scope === actual[index])
  );
}

function sameStaticParameters(
  declared: readonly { name: string; value: string }[] | undefined,
  actual: Readonly<Record<string, string>> | undefined
): boolean {
  const expected = [...(declared ?? [])]
    .map(({ name, value }) => [name, value] as const)
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    );
  const received = Object.entries(actual ?? {}).sort(([leftName], [rightName]) =>
    leftName.localeCompare(rightName)
  );
  return (
    expected.length === received.length &&
    expected.every(
      ([name, value], index) => name === received[index][0] && value === received[index][1]
    )
  );
}

function assertManifestAppCredential(
  context: NonNullable<ReturnType<typeof activeManifestOAuth>>,
  appCredentialId: string,
  clientId: string,
  clientSecret?: string
): void {
  const { declaration, flow, manifest } = context;
  if (declaration.mode !== "direct" || flow.targetCredentialId !== appCredentialId) {
    throw new OAuthManifestMismatchError("OAuth app credential does not match the manifest");
  }
  const credential = manifest.credentials.find(
    (item) => item.id === declaration.clientId.credentialId
  );
  const clientIdField = credential?.fields.find(
    (field) => field.id === declaration.clientId.fieldId
  );
  const secretField = declaration.clientSecret
    ? credential?.fields.find((field) => field.id === declaration.clientSecret?.fieldId)
    : undefined;
  const stored = getCredentialData(appCredentialId);
  if (
    !credential ||
    flow.manifestCredentialId !== credential.id ||
    (declaration.clientSecret?.credentialId !== undefined &&
      declaration.clientSecret.credentialId !== credential.id) ||
    !clientIdField ||
    !stored ||
    stored.data[clientIdField.storageKey ?? clientIdField.id] !== clientId ||
    (secretField && stored.data[secretField.storageKey ?? secretField.id] !== clientSecret)
  ) {
    throw new OAuthManifestMismatchError("OAuth app values do not match the manifest target");
  }
}

function validatedAttempt(
  context: NonNullable<ReturnType<typeof activeManifestOAuth>>,
  outputCredentialType: string
): ValidatedManifestOAuthAttempt {
  if (!context.flow.targetCredentialId) {
    throw new OAuthManifestMismatchError("OAuth app credential target is missing");
  }
  return {
    manifestOAuthId: context.declaration.id,
    outputCredentialType,
    appCredentialId: context.flow.targetCredentialId,
  };
}

/** Prevent a journaled account ID from crossing integration/declaration boundaries. */
export function assertManifestOAuthCredentialTarget(
  flowId: string | undefined,
  credentialId: string | undefined,
  outputCredentialType: string,
  manifestOAuthId: string
): void {
  if (!flowId || !credentialId) return;
  const context = activeManifestOAuth(flowId);
  if (!context) return;
  const stored = getCredentialData(credentialId);
  const binding = getDb()
    .prepare(
      `SELECT 1 FROM integration_credential_bindings
       WHERE credential_id = ? AND integration_id = ? AND manifest_credential_id = ?
         AND auth_method IN ('oauth', 'oauth2') LIMIT 1`
    )
    .get(credentialId, context.flow.integrationId, manifestOAuthId);
  if (
    context.declaration.id !== manifestOAuthId ||
    context.flow.oauthCredentialId !== credentialId ||
    context.flow.targetCredentialId === credentialId ||
    !stored ||
    stored.cred.type !== outputCredentialType ||
    !binding
  ) {
    throw new OAuthManifestMismatchError(
      "OAuth account credential does not belong to this integration declaration"
    );
  }
}

export function assertDirectManifestOAuthAttempt(
  flowId: string | undefined,
  provider: OAuthProviderConfig,
  appCredentialId: string,
  clientId: string,
  clientSecret?: string
): ValidatedManifestOAuthAttempt | null {
  const context = activeManifestOAuth(flowId);
  if (!context) return null;
  const declaration = context.declaration;
  if (
    declaration.mode !== "direct" ||
    !("provider" in declaration) ||
    declaration.provider !== provider.id ||
    declaration.authorizationUrl !== provider.authUrl ||
    declaration.tokenUrl !== provider.tokenUrl ||
    !sameScopes(declaration.scopes, provider.scopes) ||
    !sameStaticParameters(declaration.authorizationParams, provider.extraAuthParams) ||
    !sameStaticParameters(declaration.tokenParams, provider.extraTokenParams)
  ) {
    throw new OAuthManifestMismatchError("OAuth provider does not match the manifest step");
  }
  assertManifestAppCredential(context, appCredentialId, clientId, clientSecret);
  return validatedAttempt(context, `oauth-token-${provider.id}`);
}

export function assertBrokerManifestOAuthAttempt(
  flowId: string | undefined,
  providerId: string
): void {
  const context = activeManifestOAuth(flowId);
  if (!context) return;
  if (context.declaration.mode !== "broker" || context.declaration.provider !== providerId) {
    throw new OAuthManifestMismatchError("OAuth broker does not match the manifest step");
  }
}

export function assertSynthesizedManifestOAuthAttempt(
  flowId: string | undefined,
  _provider: OAuthProviderConfig,
  _clientId: string,
  _clientSecret: string | undefined,
  _requestedOutputCredentialType: string
): ValidatedManifestOAuthAttempt | null {
  const context = activeManifestOAuth(flowId);
  if (!context) return null;
  // C01 currently declares only direct and broker OAuth and has no explicit
  // synthesized execution mode or output credential type. An ID convention
  // such as `oauth.synthesized` is not a security boundary: accepting it would
  // let request-controlled metadata reinterpret a direct declaration. Keep the
  // durable legacy synthesized flow available without a manifest, and reject
  // manifest-bound attempts until the schema can express both facts explicitly.
  throw new OAuthManifestMismatchError(
    "The manifest schema does not declare synthesized OAuth mode and output type"
  );
}
