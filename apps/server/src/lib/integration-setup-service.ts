import { createHash } from "node:crypto";
import {
  INTEGRATION_SETUP_SCHEMA_VERSION,
  integrationSetupCredentialSubmissionRequestSchema,
  integrationSetupDiscoveryRequestSchema,
  integrationSetupDuplicateDecisionRequestSchema,
  integrationSetupInstructionAcknowledgementRequestSchema,
  integrationSetupStartRequestSchema,
  type IntegrationAuthStatus,
  type IntegrationDiagnosticCheck,
  type IntegrationManifest,
  type IntegrationSetupCredentialSubmissionRequest,
  type IntegrationSetupDiscoveryRequest,
  type IntegrationSetupDuplicateDecisionRequest,
  type IntegrationSetupFlowSnapshot,
  type IntegrationSetupInstructionAcknowledgementRequest,
  type IntegrationSetupStartRequest,
  type IntegrationSetupStep,
} from "@chvor/shared";
import {
  createCredential,
  getCredentialData,
  listCredentialMetadata,
  updateCredentialDataIfUnchanged,
} from "../db/credential-store.ts";
import { getDb } from "../db/database.ts";
import {
  IntegrationSetupFlowExpiredError,
  IntegrationSetupFlowNotFoundError,
  IntegrationSetupRevisionConflictError,
  advanceIntegrationSetupFlow,
  cancelIntegrationSetupFlow as cancelStoredIntegrationSetupFlow,
  clearIntegrationSetupDuplicateCandidates,
  createIntegrationSetupFlow,
  expireIntegrationSetupFlows,
  getIntegrationCredentialBinding,
  getIntegrationSetupCredentialSubmissionGuard,
  getIntegrationSetupFlow,
  getIntegrationSetupStartRequestSha256,
  initializeIntegrationSetupStepJournal,
  listIntegrationSetupFlows,
  setIntegrationSetupDuplicateCandidates,
  transitionIntegrationSetupFlow,
  updateIntegrationCredentialAuthState,
  upsertIntegrationCredentialBinding,
  type IntegrationCredentialBinding,
  type IntegrationCredentialAuthMethod,
} from "../db/integration-setup-store.ts";
import { getActiveIntegrationManifest } from "./integration-manifest-catalog.ts";
import {
  integrationOAuthAccountBinding,
  integrationOAuthAccountUsesTargetApp,
  reconcileIntegrationOAuthAccountBinding,
} from "./integration-setup-oauth-accounts.ts";
import {
  integrationOAuthAccountScope,
  reusableIntegrationOAuthAccountBinding,
  validIntegrationCredentialFieldValue,
} from "./integration-setup-validation.ts";

const ADAPTER_CREDENTIAL_NAMESPACE = "credential.";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
export class IntegrationSetupRequestError extends Error {
  readonly code: string = "invalid_integration_setup_request";
}
export class IntegrationSetupManifestNotFoundError extends Error {
  readonly code = "integration_manifest_not_found";
}
export class IntegrationSetupCredentialNotFoundError extends Error {
  readonly code = "integration_credential_not_found";
}
export class IntegrationSetupCredentialChangedError extends IntegrationSetupRequestError {
  readonly code = "integration_credential_changed";
}

type ManifestCredential = IntegrationManifest["credentials"][number];
type ManifestCredentialField = ManifestCredential["fields"][number];
type ManifestContext = {
  manifest: IntegrationManifest;
  credential: ManifestCredential;
  setup: IntegrationSetupStep[];
  oauthIds: Set<string>;
};
export type CancelIntegrationSetupRequest = {
  schemaVersion: typeof INTEGRATION_SETUP_SCHEMA_VERSION;
  flowId: string;
  revision: number;
};
/** Compatibility adapters namespace credential IDs as `credential.<legacy type>`. */
export function deriveIntegrationCredentialType(manifestCredentialId: string): string {
  if (manifestCredentialId.startsWith(ADAPTER_CREDENTIAL_NAMESPACE)) {
    const adaptedType = manifestCredentialId.slice(ADAPTER_CREDENTIAL_NAMESPACE.length);
    if (adaptedType) return adaptedType;
  }
  return manifestCredentialId;
}
function requestError(message: string): never {
  throw new IntegrationSetupRequestError(message);
}
function currentManifest(integrationId: string): IntegrationManifest {
  const manifest = getActiveIntegrationManifest(integrationId);
  if (!manifest || manifest.id !== integrationId) {
    throw new IntegrationSetupManifestNotFoundError(
      `active integration manifest ${integrationId} was not found`
    );
  }
  return manifest;
}
function manifestCredential(
  manifest: IntegrationManifest,
  manifestCredentialId: string | undefined
): ManifestCredential {
  if (!manifestCredentialId) requestError("manifestCredentialId is required");
  const credential = manifest.credentials.find((item) => item.id === manifestCredentialId);
  if (!credential) requestError("manifest credential declaration does not exist");
  return credential;
}
function oauthCredentialIds(manifest: IntegrationManifest, credentialId: string): Set<string> {
  const ids = new Set<string>();
  for (const oauth of manifest.oauth) {
    if (
      oauth.mode === "direct" &&
      (oauth.clientId.credentialId === credentialId ||
        oauth.clientSecret?.credentialId === credentialId)
    ) {
      ids.add(oauth.id);
    }
  }
  for (const oauth of manifest.oauth) {
    if (oauth.mode !== "broker") continue;
    const dependentTool = manifest.tools.some(
      (tool) =>
        tool.oauthId === oauth.id &&
        tool.credentialFields.some((ref) => ref.credentialId === credentialId)
    );
    if (dependentTool || manifest.credentials.length === 1) ids.add(oauth.id);
  }
  return ids;
}
function scopedSetup(
  manifest: IntegrationManifest,
  credential: ManifestCredential
): { setup: IntegrationSetupStep[]; oauthIds: Set<string> } {
  const oauthIds = oauthCredentialIds(manifest, credential.id);
  const toolIds = new Set(
    manifest.tools
      .filter(
        (tool) =>
          tool.credentialFields.some((ref) => ref.credentialId === credential.id) ||
          (tool.oauthId !== undefined && oauthIds.has(tool.oauthId))
      )
      .map((tool) => tool.id)
  );
  const diagnosticIds = new Set(
    manifest.diagnostics
      .filter((check) => {
        if (check.kind === "credential") {
          return check.credentialField.credentialId === credential.id;
        }
        if (check.kind === "tool") return toolIds.has(check.toolId);
        return (
          check.credentialFields.length > 0 &&
          check.credentialFields.every((ref) => ref.credentialId === credential.id)
        );
      })
      .map((check) => check.id)
  );
  const setup = manifest.setup.filter((step) => {
    if (step.kind === "instruction") return true;
    if (step.kind === "credential") return step.credentialId === credential.id;
    if (step.kind === "oauth") return oauthIds.has(step.oauthId);
    return diagnosticIds.has(step.checkId);
  });
  return { setup, oauthIds };
}

function contextForStart(request: IntegrationSetupStartRequest): ManifestContext {
  const manifest = currentManifest(request.integrationId);
  if (request.manifestVersion !== manifest.version) {
    requestError("manifestVersion does not match the active integration manifest");
  }
  const credential = manifestCredential(manifest, request.manifestCredentialId);
  if (request.credentialType !== deriveIntegrationCredentialType(credential.id)) {
    requestError("credentialType does not match the manifest credential declaration");
  }
  return { manifest, credential, ...scopedSetup(manifest, credential) };
}
function contextForFlow(flow: IntegrationSetupFlowSnapshot): ManifestContext {
  const manifest = currentManifest(flow.integrationId);
  if (manifest.version !== flow.manifestVersion) {
    requestError("the setup flow manifest version is no longer active");
  }
  const credential = manifestCredential(manifest, flow.manifestCredentialId);
  if (deriveIntegrationCredentialType(credential.id) !== flow.credentialType) {
    requestError("the setup flow credential declaration is invalid");
  }
  return { manifest, credential, ...scopedSetup(manifest, credential) };
}

function startRequestSha256(request: IntegrationSetupStartRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.schemaVersion,
        request.idempotencyKey ?? null,
        request.integrationId,
        request.manifestVersion,
        request.manifestCredentialId ?? null,
        request.targetCredentialId ?? null,
        request.oauthCredentialId ?? null,
        request.credentialType,
        request.mode,
      ]),
      "utf8"
    )
    .digest("hex");
}
function requireFlow(id: string): IntegrationSetupFlowSnapshot {
  expireIntegrationSetupFlows();
  const flow = getIntegrationSetupFlow(id);
  if (!flow) {
    throw new IntegrationSetupFlowNotFoundError(`integration setup flow ${id} not found`);
  }
  if (flow.status === "expired") {
    throw new IntegrationSetupFlowExpiredError(`integration setup flow ${id} has expired`);
  }
  return flow;
}

function referencedFlow(
  pathFlowId: string,
  bodyFlowId: string,
  revision: number
): IntegrationSetupFlowSnapshot {
  if (pathFlowId !== bodyFlowId) requestError("flowId does not match the request path");
  const flow = requireFlow(pathFlowId);
  if (flow.revision !== revision) {
    throw new IntegrationSetupRevisionConflictError(revision, flow.revision);
  }
  return flow;
}
function matchingCredential(id: string, type: string) {
  const credential = listCredentialMetadata().find((item) => item.id === id);
  if (!credential || credential.type !== type) {
    throw new IntegrationSetupCredentialNotFoundError(
      `credential ${id} is not available for this integration setup`
    );
  }
  return credential;
}
type CredentialCiphertextVersion = { encryptedData: string; sha256: string };

function encryptedDataSha256(encryptedData: string): string {
  return createHash("sha256").update(encryptedData, "utf8").digest("hex");
}

function matchingCredentialVersion(id: string, type: string): CredentialCiphertextVersion {
  matchingCredential(id, type);
  const stored = getCredentialData(id);
  if (!stored || stored.cred.type !== type) {
    throw new IntegrationSetupCredentialNotFoundError(
      `credential ${id} is not available for this integration setup`
    );
  }
  return {
    encryptedData: stored.cred.encryptedData,
    sha256: encryptedDataSha256(stored.cred.encryptedData),
  };
}

function validateOauthCredentialTarget(
  id: string,
  context: ManifestContext,
  targetCredentialId: string | undefined
): IntegrationCredentialBinding {
  const firstOauthStep = context.setup.find((step) => step.kind === "oauth");
  const scope = integrationOAuthAccountScope(context.manifest, firstOauthStep?.id);
  const binding = scope ? integrationOAuthAccountBinding(targetCredentialId, scope, id) : null;
  if (!binding) {
    throw new IntegrationSetupCredentialNotFoundError(
      `OAuth credential ${id} is not available for this integration setup`
    );
  }
  return binding;
}

function duplicateCredentialIds(flow: IntegrationSetupFlowSnapshot): string[] {
  return listCredentialMetadata()
    .filter(
      (credential) =>
        credential.type === flow.credentialType && credential.id !== flow.targetCredentialId
    )
    .map((credential) => credential.id);
}

function oauthAccountCredentialIds(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext
): string[] {
  const scope = integrationOAuthAccountScope(context.manifest, flow.currentStepId);
  if (!scope) return [];
  return listCredentialMetadata().flatMap((credential) => {
    const binding = integrationOAuthAccountBinding(flow.targetCredentialId, scope, credential.id);
    if (!binding) return [];
    reconcileIntegrationOAuthAccountBinding(scope, binding);
    return [credential.id];
  });
}
function activeStep(flow: IntegrationSetupFlowSnapshot) {
  return flow.steps.find((step) => step.status === "active");
}
function ensureActiveCredentialStep(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext
): void {
  const step = activeStep(flow);
  if (!step || step.kind !== "credential")
    requestError("the current step is not a credential step");
  const declaration = context.setup.find((item) => item.id === step.id);
  if (
    !declaration ||
    declaration.kind !== "credential" ||
    declaration.credentialId !== context.credential.id
  ) {
    requestError("active credential step does not match the setup credential declaration");
  }
}

function pauseForDuplicates(
  flow: IntegrationSetupFlowSnapshot,
  credentialIds: readonly string[]
): IntegrationSetupFlowSnapshot {
  const candidates = setIntegrationSetupDuplicateCandidates(flow.id, flow.revision, credentialIds);
  return transitionIntegrationSetupFlow(candidates.id, candidates.revision, {
    status: "awaiting-confirmation",
  });
}

function fieldStorageKey(field: ManifestCredentialField): string {
  return ("storageKey" in field ? field.storageKey : undefined) ?? field.id;
}

function credentialFailureCode(
  credentialId: string | undefined,
  credential: ManifestCredential,
  onlyFieldId?: string
): string | null {
  if (!credentialId) return "credential_target_missing";
  const stored = getCredentialData(credentialId);
  if (!stored || stored.cred.type !== deriveIntegrationCredentialType(credential.id)) {
    return "credential_target_invalid";
  }
  const fields = onlyFieldId
    ? credential.fields.filter((field) => field.id === onlyFieldId)
    : credential.fields.filter((field) => field.required);
  if (fields.length === 0 && onlyFieldId) return "diagnostic_reference_invalid";
  for (const field of fields) {
    const value = stored.data[fieldStorageKey(field)];
    if (!validIntegrationCredentialFieldValue(field, value)) {
      return value === undefined || value === ""
        ? "credential_field_missing"
        : "credential_field_invalid";
    }
  }
  return null;
}

function accountIdentity(
  credentialId: string,
  credential: ManifestCredential
): { source?: string; label?: string } {
  const stored = getCredentialData(credentialId);
  if (!stored) return {};
  const values = credential.fields
    .filter((field) => field.sensitivity !== "secret")
    .flatMap((field) => {
      const value = stored.data[fieldStorageKey(field)];
      if (!validIntegrationCredentialFieldValue(field, value)) return [];
      const fingerprintValue =
        field.sensitivity === "url"
          ? (() => {
              const url = new URL(value);
              url.search = "";
              return url.href;
            })()
          : value.trim();
      return [{ field, value: fingerprintValue }];
    })
    .sort((left, right) => left.field.id.localeCompare(right.field.id));
  const label = values.find(({ field }) =>
    /^(?:email|username|user-id|userid|account|domain|host)$/.test(field.id)
  )?.value;
  return {
    ...(values.length > 0
      ? {
          source: JSON.stringify([
            credential.id,
            ...values.map(({ field, value }) => [field.id, value]),
          ]),
        }
      : {}),
    ...(label ? { label: label.slice(0, 320) } : {}),
  };
}

function authMethod(context: ManifestContext): IntegrationCredentialAuthMethod {
  return context.oauthIds.size > 0 ? "oauth2" : "credential";
}

function bindCredential(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext,
  credentialId: string,
  authStatus: IntegrationAuthStatus,
  failureCode?: string | null
): void {
  const key = {
    credentialId,
    integrationId: flow.integrationId,
    manifestCredentialId: context.credential.id,
  };
  const existing = getIntegrationCredentialBinding(key);
  const identity = accountIdentity(credentialId, context.credential);
  upsertIntegrationCredentialBinding({
    ...key,
    manifestId: context.manifest.id,
    manifestVersion: context.manifest.version,
    authMethod: existing?.authMethod ?? authMethod(context),
    authStatus,
    failureCode: authStatus === "active" ? null : (failureCode ?? existing?.failureCode ?? null),
    tokenExpiresAt: existing?.tokenExpiresAt ?? null,
    scopes: existing?.scopes ?? [],
    ...(identity.source
      ? { accountFingerprintSource: identity.source }
      : { accountFingerprint: existing?.accountFingerprint ?? null }),
    accountLabel: identity.label ?? existing?.accountLabel ?? null,
    authCheckedAt: existing?.authCheckedAt ?? null,
  });
}

function hasRemainingOauth(flow: IntegrationSetupFlowSnapshot): boolean {
  return flow.steps.some(
    (step) => step.kind === "oauth" && (step.status === "pending" || step.status === "active")
  );
}

function failCurrentStep(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext,
  failureCode: string
): IntegrationSetupFlowSnapshot {
  const step = activeStep(flow);
  if (flow.targetCredentialId) {
    bindCredential(flow, context, flow.targetCredentialId, "failed", failureCode);
  }
  return transitionIntegrationSetupFlow(flow.id, flow.revision, {
    status: "failed",
    authStatus: "failed",
    failureCode,
    ...(step ? { step: { id: step.id, status: "failed" as const, failureCode } } : {}),
  });
}

function diagnosticForStep(
  context: ManifestContext,
  stepId: string
): IntegrationDiagnosticCheck | null {
  const declaration = context.setup.find((step) => step.id === stepId);
  if (!declaration || declaration.kind !== "diagnostic") return null;
  return context.manifest.diagnostics.find((check) => check.id === declaration.checkId) ?? null;
}

function diagnosticFailureCode(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext,
  check: IntegrationDiagnosticCheck
): string | null {
  if (check.kind === "credential") {
    if (check.credentialField.credentialId !== context.credential.id) {
      return "diagnostic_reference_invalid";
    }
    return credentialFailureCode(
      flow.targetCredentialId,
      context.credential,
      check.credentialField.fieldId
    );
  }
  if (check.kind === "tool") {
    return context.manifest.tools.some((tool) => tool.id === check.toolId)
      ? null
      : "diagnostic_reference_invalid";
  }
  if (check.credentialFields.some((ref) => ref.credentialId !== context.credential.id)) {
    return "diagnostic_reference_invalid";
  }
  for (const ref of check.credentialFields) {
    const failure = credentialFailureCode(flow.targetCredentialId, context.credential, ref.fieldId);
    if (failure) return failure;
  }
  return null;
}

/**
 * Advance consecutive declarative diagnostics from trusted manifest and credential state.
 * The loop deliberately stops at instructions, credential input, and OAuth so those actors
 * remain explicit and cannot be forged through the public discovery endpoint.
 */
function settleActivatedStep(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext
): IntegrationSetupFlowSnapshot {
  let settled = flow;
  while (true) {
    const step = activeStep(settled);
    if (!step) return settled;
    if (step.kind === "credential") {
      ensureActiveCredentialStep(settled, context);
      if (settled.targetCredentialId || settled.mode !== "setup") return settled;
      const candidateIds = duplicateCredentialIds(settled);
      return candidateIds.length > 0 ? pauseForDuplicates(settled, candidateIds) : settled;
    }
    if (step.kind === "oauth") {
      if (settled.oauthCredentialId || settled.oauthCreateAdditional) return settled;
      const candidateIds = oauthAccountCredentialIds(settled, context);
      return candidateIds.length > 0 ? pauseForDuplicates(settled, candidateIds) : settled;
    }
    if (step.kind !== "diagnostic") return settled;
    const check = diagnosticForStep(context, step.id);
    if (!check) return failCurrentStep(settled, context, "diagnostic_reference_invalid");
    const failure = diagnosticFailureCode(settled, context, check);
    if (failure) return failCurrentStep(settled, context, failure);
    if (!hasRemainingOauth(settled) && settled.targetCredentialId) {
      bindCredential(settled, context, settled.targetCredentialId, "active", null);
      if (settled.authStatus !== "active") {
        settled = transitionIntegrationSetupFlow(settled.id, settled.revision, {
          authStatus: "active",
          failureCode: null,
        });
      }
    }
    settled = advanceIntegrationSetupFlow(settled.id, settled.revision);
  }
}
function advanceAndSettle(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext
): IntegrationSetupFlowSnapshot {
  return settleActivatedStep(advanceIntegrationSetupFlow(flow.id, flow.revision), context);
}

function startInTransaction(
  request: IntegrationSetupStartRequest,
  context: ManifestContext,
  requestSha256: string | undefined
): IntegrationSetupFlowSnapshot {
  const existing = existingIdempotentStart(request, requestSha256);
  if (existing) return existing;
  const targetCredentialEncryptedDataSha256 = request.targetCredentialId
    ? matchingCredentialVersion(request.targetCredentialId, request.credentialType).sha256
    : undefined;
  let oauthAccountBinding: IntegrationCredentialBinding | undefined;
  if (request.oauthCredentialId) {
    if (context.oauthIds.size === 0) requestError("oauthCredentialId requires an OAuth setup step");
    oauthAccountBinding = validateOauthCredentialTarget(
      request.oauthCredentialId,
      context,
      request.targetCredentialId
    );
  }
  if (
    request.mode === "reauthenticate" &&
    context.oauthIds.size > 0 &&
    !request.oauthCredentialId
  ) {
    requestError("OAuth reauthentication requires oauthCredentialId");
  }
  let flow = createIntegrationSetupFlow({
    ...(request.idempotencyKey
      ? { id: request.idempotencyKey, startRequestSha256: requestSha256 }
      : {}),
    integrationId: context.manifest.id,
    manifestVersion: context.manifest.version,
    manifestCredentialId: context.credential.id,
    ...(request.targetCredentialId ? { targetCredentialId: request.targetCredentialId } : {}),
    ...(targetCredentialEncryptedDataSha256 ? { targetCredentialEncryptedDataSha256 } : {}),
    ...(request.oauthCredentialId ? { oauthCredentialId: request.oauthCredentialId } : {}),
    credentialType: deriveIntegrationCredentialType(context.credential.id),
    mode: request.mode,
  });
  flow = initializeIntegrationSetupStepJournal(
    flow.id,
    flow.revision,
    context.setup.map((step) => ({ id: step.id, kind: step.kind }))
  );
  flow = advanceIntegrationSetupFlow(flow.id, flow.revision);
  if (request.mode === "reauthenticate" && request.targetCredentialId) {
    if (oauthAccountBinding) {
      updateIntegrationCredentialAuthState(oauthAccountBinding, {
        authStatus: "reauthentication-required",
        failureCode: "reauthentication_required",
      });
    } else {
      bindCredential(
        flow,
        context,
        request.targetCredentialId,
        "reauthentication-required",
        "reauthentication_required"
      );
    }
    flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
      authStatus: "reauthentication-required",
      failureCode: "reauthentication_required",
    });
  }
  return settleActivatedStep(flow, context);
}
function existingIdempotentStart(
  request: IntegrationSetupStartRequest,
  requestSha256: string | undefined
): IntegrationSetupFlowSnapshot | null {
  if (!request.idempotencyKey) return null;
  expireIntegrationSetupFlows();
  const existing = getIntegrationSetupFlow(request.idempotencyKey);
  if (!existing) return null;
  if (getIntegrationSetupStartRequestSha256(existing.id) !== requestSha256) {
    requestError("idempotencyKey was already used with different setup metadata");
  }
  return existing;
}
function validateStartTargets(request: IntegrationSetupStartRequest): void {
  if (request.mode === "setup" && (request.targetCredentialId || request.oauthCredentialId)) {
    requestError("setup mode cannot select target credentials before confirmation");
  }
  if (
    (request.mode === "reconfigure" || request.mode === "reauthenticate") &&
    !request.targetCredentialId
  ) {
    requestError(`${request.mode} mode requires targetCredentialId`);
  }
}
export function startIntegrationSetup(input: unknown): IntegrationSetupFlowSnapshot {
  const request = integrationSetupStartRequestSchema.parse(input);
  const requestSha256 = request.idempotencyKey ? startRequestSha256(request) : undefined;
  const existing = existingIdempotentStart(request, requestSha256);
  if (existing) {
    if (!TERMINAL_STATUSES.has(existing.status)) contextForFlow(existing);
    return existing;
  }
  validateStartTargets(request);
  const context = contextForStart(request);
  return getDb()
    .transaction(() => startInTransaction(request, context, requestSha256))
    .immediate();
}

export function getIntegrationSetup(id: string): IntegrationSetupFlowSnapshot {
  const flow = requireFlow(id);
  if (!TERMINAL_STATUSES.has(flow.status)) contextForFlow(flow);
  return flow;
}

export function listIntegrationSetups(): IntegrationSetupFlowSnapshot[] {
  expireIntegrationSetupFlows();
  return listIntegrationSetupFlows().filter((flow) => {
    if (TERMINAL_STATUSES.has(flow.status)) return true;
    try {
      contextForFlow(flow);
      return true;
    } catch (error) {
      if (
        error instanceof IntegrationSetupManifestNotFoundError ||
        error instanceof IntegrationSetupRequestError
      ) {
        return false;
      }
      throw error;
    }
  });
}

function normalizedCredentialData(
  request: IntegrationSetupCredentialSubmissionRequest,
  credential: ManifestCredential,
  creating: boolean
): Record<string, string> {
  const declared = new Map(credential.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(request.data)) {
    if (!declared.has(key)) requestError("credential data contains an undeclared field");
  }
  const data: Record<string, string> = {};
  for (const field of credential.fields) {
    const submitted = request.data[field.id];
    const fallback = "default" in field ? field.default : undefined;
    const value = creating && (submitted === undefined || submitted === "") ? fallback : submitted;
    if (creating && field.required && (value === undefined || value === "")) {
      requestError("credential data is missing a required manifest field");
    }
    if (
      value !== undefined &&
      value !== "" &&
      !validIntegrationCredentialFieldValue(field, value)
    ) {
      requestError("credential data contains an invalid manifest field value");
    }
    if (value !== undefined) data[fieldStorageKey(field)] = value;
  }
  return data;
}

function submitCredentialsInTransaction(
  pathFlowId: string,
  request: IntegrationSetupCredentialSubmissionRequest
): IntegrationSetupFlowSnapshot {
  let flow = referencedFlow(pathFlowId, request.flowId, request.revision);
  const context = contextForFlow(flow);
  const step = activeStep(flow);
  if (
    flow.status !== "awaiting-input" ||
    !step ||
    step.kind !== "credential" ||
    step.id !== request.stepId
  ) {
    requestError("credential submission is not actionable for the current setup step");
  }
  ensureActiveCredentialStep(flow, context);

  let credentialId = flow.targetCredentialId;
  let targetCredentialEncryptedDataSha256: string;
  if (credentialId) {
    const current = matchingCredentialVersion(credentialId, flow.credentialType);
    const guard = getIntegrationSetupCredentialSubmissionGuard(flow.id);
    if (
      guard.targetCredentialId !== credentialId ||
      guard.targetCredentialEncryptedDataSha256 === undefined ||
      guard.targetCredentialEncryptedDataSha256 !== current.sha256
    ) {
      throw new IntegrationSetupCredentialChangedError(
        `credential ${credentialId} does not match the setup flow snapshot`
      );
    }
    const patch = normalizedCredentialData(request, context.credential, false);
    const result = updateCredentialDataIfUnchanged(credentialId, current.encryptedData, patch);
    if (result.outcome === "not-found") {
      throw new IntegrationSetupCredentialNotFoundError(
        `credential ${credentialId} could not be updated`
      );
    }
    if (result.outcome !== "updated") {
      throw new IntegrationSetupCredentialChangedError(
        `credential ${credentialId} changed after this setup flow started`
      );
    }
    const updated = getCredentialData(credentialId);
    if (!updated) {
      throw new IntegrationSetupCredentialNotFoundError(
        `credential ${credentialId} could not be read after update`
      );
    }
    targetCredentialEncryptedDataSha256 = encryptedDataSha256(updated.cred.encryptedData);
  } else {
    const guard = getIntegrationSetupCredentialSubmissionGuard(flow.id);
    const candidateIds = duplicateCredentialIds(flow);
    if (!guard.credentialCreateAdditional && candidateIds.length > 0) {
      return pauseForDuplicates(flow, candidateIds);
    }
    const data = normalizedCredentialData(request, context.credential, true);
    const created = createCredential(context.credential.name, flow.credentialType, data);
    credentialId = created.id;
    targetCredentialEncryptedDataSha256 = matchingCredentialVersion(
      credentialId,
      flow.credentialType
    ).sha256;
  }

  const failure = credentialFailureCode(credentialId, context.credential);
  if (failure) {
    flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
      targetCredentialId: credentialId,
      targetCredentialEncryptedDataSha256,
      credentialCreateAdditional: false,
    });
    return failCurrentStep(flow, context, failure);
  }
  bindCredential(flow, context, credentialId, "active", null);
  const awaitsOauth = hasRemainingOauth(flow);
  flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
    targetCredentialId: credentialId,
    targetCredentialEncryptedDataSha256,
    credentialCreateAdditional: false,
    ...(awaitsOauth ? {} : { authStatus: "active" as const, failureCode: null }),
  });
  return advanceAndSettle(flow, context);
}

export function submitIntegrationSetupCredentials(
  pathFlowId: string,
  input: unknown
): IntegrationSetupFlowSnapshot {
  const request = integrationSetupCredentialSubmissionRequestSchema.parse(input);
  return getDb()
    .transaction(() => submitCredentialsInTransaction(pathFlowId, request))
    .immediate();
}

function acknowledgeInTransaction(
  pathFlowId: string,
  request: IntegrationSetupInstructionAcknowledgementRequest
): IntegrationSetupFlowSnapshot {
  const flow = referencedFlow(pathFlowId, request.flowId, request.revision);
  const context = contextForFlow(flow);
  const step = activeStep(flow);
  if (
    flow.status !== "awaiting-input" ||
    !step ||
    step.kind !== "instruction" ||
    step.id !== request.stepId
  ) {
    requestError("instruction acknowledgement is not actionable for the current setup step");
  }
  return advanceAndSettle(flow, context);
}

export function acknowledgeIntegrationSetupInstruction(
  pathFlowId: string,
  input: unknown
): IntegrationSetupFlowSnapshot {
  const request = integrationSetupInstructionAcknowledgementRequestSchema.parse(input);
  return getDb()
    .transaction(() => acknowledgeInTransaction(pathFlowId, request))
    .immediate();
}

function clearDuplicateCandidates(
  flow: IntegrationSetupFlowSnapshot
): IntegrationSetupFlowSnapshot {
  return clearIntegrationSetupDuplicateCandidates(flow.id, flow.revision);
}

function confirmOAuthDuplicate(
  flow: IntegrationSetupFlowSnapshot,
  context: ManifestContext,
  request: Exclude<IntegrationSetupDuplicateDecisionRequest, { decision: "cancel" }>
): IntegrationSetupFlowSnapshot {
  if (request.decision === "create-additional") {
    flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
      status: "awaiting-oauth",
      oauthCredentialId: null,
      oauthCreateAdditional: true,
    });
    return clearDuplicateCandidates(flow);
  }
  if (!flow.duplicateCandidates.some((candidate) => candidate.id === request.credentialId)) {
    requestError("credentialId is not a duplicate candidate for this setup flow");
  }
  const scope = integrationOAuthAccountScope(context.manifest, flow.currentStepId);
  const binding = scope
    ? integrationOAuthAccountBinding(flow.targetCredentialId, scope, request.credentialId)
    : null;
  if (!scope || !binding) {
    throw new IntegrationSetupCredentialNotFoundError(
      `OAuth credential ${request.credentialId} is not available for this integration setup`
    );
  }
  if (
    request.decision === "reuse-existing" &&
    !reusableIntegrationOAuthAccountBinding(scope, binding)
  ) {
    reconcileIntegrationOAuthAccountBinding(scope, binding);
    return getIntegrationSetupFlow(flow.id) ?? flow;
  }
  if (
    request.decision === "reuse-existing" &&
    !integrationOAuthAccountUsesTargetApp(request.credentialId, flow.targetCredentialId)
  ) {
    requestError(
      "OAuth account was authorized with a different app credential; choose replace-existing"
    );
  }
  flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
    status: "awaiting-oauth",
    oauthCredentialId: request.credentialId,
    oauthCreateAdditional: false,
    ...(request.decision === "reuse-existing"
      ? { authStatus: "active" as const, failureCode: null }
      : {}),
  });
  flow = clearDuplicateCandidates(flow);
  return request.decision === "replace-existing" ? flow : advanceAndSettle(flow, context);
}

function confirmInTransaction(
  pathFlowId: string,
  request: IntegrationSetupDuplicateDecisionRequest
): IntegrationSetupFlowSnapshot {
  let flow = referencedFlow(pathFlowId, request.flowId, request.revision);
  if (flow.status !== "awaiting-confirmation") {
    requestError("duplicate confirmation is not actionable for this setup flow");
  }
  if (request.decision === "cancel") {
    return cancelStoredIntegrationSetupFlow(flow.id, flow.revision);
  }

  const context = contextForFlow(flow);
  if (activeStep(flow)?.kind === "oauth") {
    return confirmOAuthDuplicate(flow, context, request);
  }
  if (request.decision === "reuse-existing" || request.decision === "replace-existing") {
    if (!flow.duplicateCandidates.some((candidate) => candidate.id === request.credentialId)) {
      requestError("credentialId is not a duplicate candidate for this setup flow");
    }
    const targetCredentialEncryptedDataSha256 = matchingCredentialVersion(
      request.credentialId,
      flow.credentialType
    ).sha256;
    flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
      status: "awaiting-input",
      targetCredentialId: request.credentialId,
      targetCredentialEncryptedDataSha256,
      credentialCreateAdditional: false,
    });
    flow = clearDuplicateCandidates(flow);
    if (request.decision === "replace-existing") return flow;

    const failure = credentialFailureCode(request.credentialId, context.credential);
    if (failure) return failCurrentStep(flow, context, failure);
    bindCredential(flow, context, request.credentialId, "active", null);
    if (!hasRemainingOauth(flow)) {
      flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
        authStatus: "active",
        failureCode: null,
      });
    }
    return advanceAndSettle(flow, context);
  }

  flow = transitionIntegrationSetupFlow(flow.id, flow.revision, {
    status: "awaiting-input",
    targetCredentialId: null,
    targetCredentialEncryptedDataSha256: null,
    credentialCreateAdditional: true,
  });
  return clearDuplicateCandidates(flow);
}

export function confirmIntegrationSetupDuplicate(
  pathFlowId: string,
  input: unknown
): IntegrationSetupFlowSnapshot {
  const request = integrationSetupDuplicateDecisionRequestSchema.parse(input);
  return getDb()
    .transaction(() => confirmInTransaction(pathFlowId, request))
    .immediate();
}

function discoveryInTransaction(
  pathFlowId: string,
  request: IntegrationSetupDiscoveryRequest
): IntegrationSetupFlowSnapshot {
  const flow = referencedFlow(pathFlowId, request.flowId, request.revision);
  const context = contextForFlow(flow);
  const step = activeStep(flow);
  if (
    flow.status !== "discovering" ||
    !step ||
    step.kind !== "diagnostic" ||
    step.id !== request.stepId
  ) {
    requestError("diagnostic discovery is not actionable for the current setup step");
  }
  return settleActivatedStep(flow, context);
}

export function submitIntegrationSetupDiscovery(
  pathFlowId: string,
  input: unknown
): IntegrationSetupFlowSnapshot {
  const request = integrationSetupDiscoveryRequestSchema.parse(input);
  return getDb()
    .transaction(() => discoveryInTransaction(pathFlowId, request))
    .immediate();
}

export function cancelIntegrationSetup(
  pathFlowId: string,
  request: CancelIntegrationSetupRequest
): IntegrationSetupFlowSnapshot {
  if (request.schemaVersion !== INTEGRATION_SETUP_SCHEMA_VERSION) {
    requestError("unsupported integration setup schemaVersion");
  }
  return getDb()
    .transaction(() => {
      const flow = referencedFlow(pathFlowId, request.flowId, request.revision);
      if (TERMINAL_STATUSES.has(flow.status)) requestError("setup flow is already terminal");
      return cancelStoredIntegrationSetupFlow(flow.id, flow.revision);
    })
    .immediate();
}
