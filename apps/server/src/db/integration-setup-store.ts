import { randomUUID } from "node:crypto";
import {
  INTEGRATION_SETUP_LIMITS,
  INTEGRATION_SETUP_SCHEMA_VERSION,
  integrationAuthStatusSchema,
  integrationManifestIdSchema,
  integrationSetupDuplicateCandidateSchema,
  integrationSetupFailureCodeSchema,
  integrationSetupFlowSnapshotSchema,
  integrationSetupStartRequestSchema,
  integrationSetupStatusSchema,
  type IntegrationAuthStatus,
  type IntegrationSetupDuplicateCandidate,
  type IntegrationSetupFailureCode,
  type IntegrationSetupFlowSnapshot,
  type IntegrationSetupMode,
  type IntegrationSetupStatus,
  type IntegrationSetupStep,
  type IntegrationSetupStepKind,
  type IntegrationSetupStepStatus,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import {
  IntegrationSetupFlowExpiredError,
  IntegrationSetupFlowNotFoundError,
  IntegrationSetupIllegalTransitionError,
  IntegrationSetupRevisionConflictError,
} from "./integration-setup-errors.ts";

const FLOW_PAGE_MAX = 100;
const DEFAULT_FLOW_TTL_MS = 30 * 60 * 1_000;
const TERMINAL_FLOW_STATUSES = new Set<IntegrationSetupStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export {
  IntegrationSetupFlowExpiredError,
  IntegrationSetupFlowNotFoundError,
  IntegrationSetupIllegalTransitionError,
  IntegrationSetupRevisionConflictError,
};

// prettier-ignore
type FlowRow = { id: string; integration_id: string; manifest_version: string; manifest_credential_id: string | null; credential_type: string; mode: string; status: string; auth_status: string; current_step: number; revision: number; start_request_sha256: string | null; failure_code: string | null; duplicate_candidate_ids: string; target_credential_id: string | null; target_credential_encrypted_data_sha256: string | null; credential_create_additional: number; oauth_credential_id: string | null; oauth_create_additional: number; created_at: string; updated_at: string; expires_at: string; completed_at: string | null };
// prettier-ignore
type StepRow = { flow_id: string; position: number; step_id: string; kind: string; status: string; attempts: number; failure_code: string | null; started_at: string | null; completed_at: string | null };

const FLOW_COLUMNS = `id, integration_id, manifest_version, manifest_credential_id,
  credential_type, mode, status, auth_status, current_step, revision, start_request_sha256,
  failure_code,
  duplicate_candidate_ids, target_credential_id, target_credential_encrypted_data_sha256,
  credential_create_additional, oauth_credential_id, oauth_create_additional, created_at,
  updated_at, expires_at, completed_at`;

function identifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new TypeError(`${label} contains unsafe characters`);
  return value;
}

function isoTimestamp(value: string, label: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  return new Date(value).toISOString();
}

function currentIso(): string {
  return new Date().toISOString();
}

function monotonicTimestamp(candidate: string, persisted: string): string {
  return Date.parse(candidate) >= Date.parse(persisted) ? candidate : persisted;
}

function checkedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > INTEGRATION_SETUP_LIMITS.revision) {
    throw new RangeError("expectedRevision must be a positive bounded integer");
  }
  return value;
}

function checkedFailureCode(value: string | null | undefined): IntegrationSetupFailureCode | null {
  return value == null ? null : integrationSetupFailureCodeSchema.parse(value);
}

function checkAuthTransition(from: IntegrationAuthStatus, to: IntegrationAuthStatus): void {
  if (from !== to && to === "unknown") {
    throw new IntegrationSetupIllegalTransitionError(
      `illegal auth transition from ${from} to ${to}`
    );
  }
}

function flowRow(id: string): FlowRow {
  const row = getDb()
    .prepare(`SELECT ${FLOW_COLUMNS} FROM integration_setup_flows WHERE id = ?`)
    .get(identifier(id, "flow id")) as FlowRow | undefined;
  if (!row) throw new IntegrationSetupFlowNotFoundError(`integration setup flow ${id} not found`);
  return row;
}

function stepsForFlow(id: string): StepRow[] {
  return getDb()
    .prepare(
      `SELECT flow_id, position, step_id, kind, status, attempts, failure_code,
              started_at, completed_at
         FROM integration_setup_steps WHERE flow_id = ? ORDER BY position`
    )
    .all(id) as StepRow[];
}

function duplicateCandidateIds(raw: string, flowId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`corrupt integration setup flow ${flowId}: invalid candidate journal`, {
      cause: error,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string" || !SAFE_IDENTIFIER.test(value))
  ) {
    throw new Error(`corrupt integration setup flow ${flowId}: unsafe candidate journal`);
  }
  return parsed;
}

function safeCandidateName(value: unknown): string {
  if (typeof value !== "string") return "Saved credential";
  const normalized = Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, INTEGRATION_SETUP_LIMITS.name)
    .trim();
  return normalized || "Saved credential";
}

function candidateForId(
  flow: FlowRow,
  credentialId: string
): IntegrationSetupDuplicateCandidate | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT c.id, c.name, c.type,
              (SELECT b.account_label FROM integration_credential_bindings b
                WHERE b.credential_id = c.id AND b.integration_id = ?
                ORDER BY CASE WHEN (? IS NOT NULL AND b.manifest_credential_id = ?)
                         THEN 0 ELSE 1 END, b.updated_at DESC LIMIT 1) AS account_label
         FROM credentials c WHERE c.id = ?`
    )
    .get(
      flow.integration_id,
      flow.manifest_credential_id,
      flow.manifest_credential_id,
      credentialId
    ) as { id: string; name: unknown; type: string; account_label: string | null } | undefined;
  if (!row) return null;
  const activeStep = db
    .prepare(
      "SELECT kind FROM integration_setup_steps WHERE flow_id = ? AND status = 'active' LIMIT 1"
    )
    .get(flow.id) as { kind: string } | undefined;
  const oauthBinding =
    activeStep?.kind === "oauth"
      ? (db
          .prepare(
            `SELECT auth_status FROM integration_credential_bindings
             WHERE credential_id = ? AND integration_id = ?
               AND auth_method IN ('oauth', 'oauth2')
             ORDER BY updated_at DESC LIMIT 1`
          )
          .get(row.id, flow.integration_id) as { auth_status: string } | undefined)
      : undefined;
  const allowedDecisions: IntegrationSetupDuplicateCandidate["allowedDecisions"] =
    activeStep?.kind === "oauth" && oauthBinding?.auth_status !== "active"
      ? ["replace-existing"]
      : ["reuse-existing", "replace-existing"];
  return integrationSetupDuplicateCandidateSchema.parse({
    id: row.id,
    name: safeCandidateName(row.name),
    type: row.type,
    ...(row.account_label ? { accountLabel: row.account_label } : {}),
    allowedDecisions,
  });
}

function snapshotFromRow(flow: FlowRow): IntegrationSetupFlowSnapshot {
  const steps = stepsForFlow(flow.id).map((step) => ({
    id: step.step_id,
    kind: step.kind as IntegrationSetupStepKind,
    status: step.status as IntegrationSetupStepStatus,
    attempts: step.attempts,
    ...(step.failure_code ? { failureCode: step.failure_code } : {}),
    ...(step.started_at ? { startedAt: step.started_at } : {}),
    ...(step.completed_at ? { completedAt: step.completed_at } : {}),
  }));
  const active = steps.filter((step) => step.status === "active");
  const duplicateCandidates = duplicateCandidateIds(flow.duplicate_candidate_ids, flow.id).flatMap(
    (id) => {
      const candidate = candidateForId(flow, id);
      return candidate ? [candidate] : [];
    }
  );
  return integrationSetupFlowSnapshotSchema.parse({
    schemaVersion: INTEGRATION_SETUP_SCHEMA_VERSION,
    id: flow.id,
    integrationId: flow.integration_id,
    manifestVersion: flow.manifest_version,
    ...(flow.manifest_credential_id ? { manifestCredentialId: flow.manifest_credential_id } : {}),
    ...(active[0] ? { currentStepId: active[0].id } : {}),
    ...(flow.target_credential_id ? { targetCredentialId: flow.target_credential_id } : {}),
    ...(flow.oauth_credential_id ? { oauthCredentialId: flow.oauth_credential_id } : {}),
    oauthCreateAdditional: flow.oauth_create_additional === 1,
    credentialType: flow.credential_type,
    mode: flow.mode as IntegrationSetupMode,
    status: flow.status as IntegrationSetupStatus,
    authStatus: flow.auth_status as IntegrationAuthStatus,
    steps,
    duplicateCandidates,
    revision: flow.revision,
    createdAt: flow.created_at,
    updatedAt: flow.updated_at,
    expiresAt: flow.expires_at,
    ...(flow.failure_code ? { failureCode: flow.failure_code } : {}),
  });
}

/** Assemble a flow row, step journal, and candidate metadata from one read snapshot. */
function snapshotForFlowId(id: string): IntegrationSetupFlowSnapshot {
  const db = getDb();
  return db.transaction(() => snapshotFromRow(flowRow(id)))();
}

function conflict(expectedRevision: number, id: string): never {
  const actual = getDb()
    .prepare("SELECT revision FROM integration_setup_flows WHERE id = ?")
    .get(id) as { revision: number } | undefined;
  if (!actual)
    throw new IntegrationSetupFlowNotFoundError(`integration setup flow ${id} not found`);
  throw new IntegrationSetupRevisionConflictError(expectedRevision, actual.revision);
}

function flowExpired(flow: FlowRow): never {
  throw new IntegrationSetupFlowExpiredError(`integration setup flow ${flow.id} has expired`);
}

function assertMutableFlow(flow: FlowRow, now = currentIso()): void {
  if (flow.status === "expired" || Date.parse(now) >= Date.parse(flow.expires_at)) {
    flowExpired(flow);
  }
  if (TERMINAL_FLOW_STATUSES.has(flow.status as IntegrationSetupStatus)) {
    throw new IntegrationSetupIllegalTransitionError(
      "terminal integration setup flow is immutable"
    );
  }
}

function purgeIntegrationSetupSecretEnvelopes(flowId: string): void {
  getDb().prepare("DELETE FROM integration_setup_secret_envelopes WHERE flow_id = ?").run(flowId);
}

// prettier-ignore
export type CreateIntegrationSetupFlowInput = { id?: string; startRequestSha256?: string; integrationId: string; manifestVersion: string; manifestCredentialId?: string; targetCredentialId?: string; targetCredentialEncryptedDataSha256?: string; credentialCreateAdditional?: boolean; oauthCredentialId?: string; oauthCreateAdditional?: boolean; credentialType: string; mode: IntegrationSetupMode; expiresAt?: string };

function checkedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function checkedSha256(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (!SHA256_HEX.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return value;
}

function normalizedSteps(
  steps: ReadonlyArray<Pick<IntegrationSetupStep, "id" | "kind">>
): Array<{ id: string; kind: IntegrationSetupStepKind }> {
  if (steps.length > INTEGRATION_SETUP_LIMITS.steps) throw new RangeError("too many setup steps");
  const seen = new Set<string>();
  return steps.map((step) => {
    const id = integrationManifestIdSchema.parse(step.id);
    if (seen.has(id)) throw new TypeError(`duplicate integration setup step ${id}`);
    seen.add(id);
    if (!["instruction", "credential", "oauth", "diagnostic"].includes(step.kind)) {
      throw new TypeError(`unsupported integration setup step kind ${step.kind}`);
    }
    return { id, kind: step.kind };
  });
}

function insertSteps(
  flowId: string,
  steps: Array<{ id: string; kind: IntegrationSetupStepKind }>,
  now: string
): void {
  const insert = getDb().prepare(
    `INSERT INTO integration_setup_steps
       (flow_id, position, step_id, kind, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
  );
  steps.forEach((step, position) => insert.run(flowId, position, step.id, step.kind, now, now));
}

/** Create an empty resumable setup flow. */
export function createIntegrationSetupFlow(
  input: CreateIntegrationSetupFlowInput
): IntegrationSetupFlowSnapshot {
  const start = integrationSetupStartRequestSchema.parse({
    schemaVersion: INTEGRATION_SETUP_SCHEMA_VERSION,
    integrationId: input.integrationId,
    manifestVersion: input.manifestVersion,
    ...(input.manifestCredentialId ? { manifestCredentialId: input.manifestCredentialId } : {}),
    ...(input.targetCredentialId ? { targetCredentialId: input.targetCredentialId } : {}),
    ...(input.oauthCredentialId !== undefined
      ? { oauthCredentialId: input.oauthCredentialId }
      : {}),
    credentialType: input.credentialType,
    mode: input.mode,
  });
  const id = input.id ? identifier(input.id, "flow id") : randomUUID();
  const now = currentIso();
  const expiresAt = input.expiresAt
    ? isoTimestamp(input.expiresAt, "expiresAt")
    : new Date(Date.parse(now) + DEFAULT_FLOW_TTL_MS).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(now))
    throw new RangeError("expiresAt must be in the future");
  const oauthCreateAdditional =
    input.oauthCreateAdditional === undefined
      ? false
      : checkedBoolean(input.oauthCreateAdditional, "oauthCreateAdditional");
  const credentialCreateAdditional =
    input.credentialCreateAdditional === undefined
      ? false
      : checkedBoolean(input.credentialCreateAdditional, "credentialCreateAdditional");
  const targetCredentialEncryptedDataSha256 = checkedSha256(
    input.targetCredentialEncryptedDataSha256,
    "target credential encrypted-data digest"
  );
  if (targetCredentialEncryptedDataSha256 !== null && !start.targetCredentialId) {
    throw new TypeError("target credential digest requires targetCredentialId");
  }
  if (credentialCreateAdditional && start.targetCredentialId) {
    throw new TypeError("create-additional approval cannot have a targetCredentialId");
  }
  if (oauthCreateAdditional && start.oauthCredentialId) {
    throw new TypeError("OAuth create-additional approval cannot have an oauthCredentialId");
  }
  const startRequestSha256 = input.startRequestSha256 ?? null;
  if (startRequestSha256 !== null) checkedSha256(startRequestSha256, "start request digest");
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO integration_setup_flows
         (id, integration_id, manifest_id, manifest_version, manifest_credential_id,
          credential_type, mode, status, auth_status, current_step, revision,
          start_request_sha256, duplicate_candidate_ids, target_credential_id,
          target_credential_encrypted_data_sha256,
          credential_create_additional, oauth_credential_id, oauth_create_additional,
          created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting-input', 'unknown', 0, 1, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      start.integrationId,
      start.integrationId,
      start.manifestVersion,
      start.manifestCredentialId ?? null,
      start.credentialType,
      start.mode,
      startRequestSha256,
      start.targetCredentialId ?? null,
      targetCredentialEncryptedDataSha256,
      credentialCreateAdditional ? 1 : 0,
      start.oauthCredentialId ?? null,
      oauthCreateAdditional ? 1 : 0,
      now,
      now,
      expiresAt
    );
  }).immediate();
  return snapshotForFlowId(id);
}

export function getIntegrationSetupFlow(id: string): IntegrationSetupFlowSnapshot | null {
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT ${FLOW_COLUMNS} FROM integration_setup_flows WHERE id = ?`)
      .get(identifier(id, "flow id")) as FlowRow | undefined;
    return row ? snapshotFromRow(row) : null;
  })();
}

/** Read the immutable digest that binds an idempotent start key to its original metadata. */
export function getIntegrationSetupStartRequestSha256(id: string): string | null {
  return flowRow(id).start_request_sha256;
}

export type IntegrationSetupCredentialSubmissionGuard = {
  targetCredentialId?: string;
  targetCredentialEncryptedDataSha256?: string;
  credentialCreateAdditional: boolean;
};

/** Internal durable concurrency state; never serialize this through the public setup snapshot. */
export function getIntegrationSetupCredentialSubmissionGuard(
  id: string
): IntegrationSetupCredentialSubmissionGuard {
  const flow = flowRow(id);
  return {
    ...(flow.target_credential_id ? { targetCredentialId: flow.target_credential_id } : {}),
    ...(flow.target_credential_encrypted_data_sha256
      ? { targetCredentialEncryptedDataSha256: flow.target_credential_encrypted_data_sha256 }
      : {}),
    credentialCreateAdditional: flow.credential_create_additional === 1,
  };
}

// prettier-ignore
export type ListIntegrationSetupFlowsOptions = { integrationId?: string; status?: IntegrationSetupStatus; limit?: number };

export function listIntegrationSetupFlows(
  options: ListIntegrationSetupFlowsOptions = {}
): IntegrationSetupFlowSnapshot[] {
  const limit = options.limit ?? FLOW_PAGE_MAX;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FLOW_PAGE_MAX) {
    throw new RangeError(`limit must be between 1 and ${FLOW_PAGE_MAX}`);
  }
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.integrationId) {
    where.push("integration_id = ?");
    params.push(integrationManifestIdSchema.parse(options.integrationId));
  }
  if (options.status) {
    where.push("status = ?");
    params.push(integrationSetupStatusSchema.parse(options.status));
  }
  const db = getDb();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT ${FLOW_COLUMNS} FROM integration_setup_flows
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, id DESC LIMIT ?`
      )
      .all(...params, limit) as FlowRow[];
    return rows.map(snapshotFromRow);
  })();
}

/** Initialize an empty step journal and CAS-bump the owning flow revision. */
export function initializeIntegrationSetupStepJournal(
  id: string,
  expectedRevision: number,
  steps: ReadonlyArray<Pick<IntegrationSetupStep, "id" | "kind">>
): IntegrationSetupFlowSnapshot {
  checkedRevision(expectedRevision);
  const normalized = normalizedSteps(steps);
  const db = getDb();
  db.transaction(() => {
    const flow = flowRow(id);
    if (flow.revision !== expectedRevision) conflict(expectedRevision, id);
    assertMutableFlow(flow);
    const count = db
      .prepare("SELECT count(*) AS count FROM integration_setup_steps WHERE flow_id = ?")
      .get(id) as { count: number };
    if (count.count !== 0) {
      throw new IntegrationSetupIllegalTransitionError(
        "integration setup step journal already exists"
      );
    }
    const now = monotonicTimestamp(currentIso(), flow.updated_at);
    insertSteps(id, normalized, now);
    const updated = db
      .prepare(
        `UPDATE integration_setup_flows SET revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(now, id, expectedRevision);
    if (updated.changes !== 1) conflict(expectedRevision, id);
  }).immediate();
  return snapshotForFlowId(id);
}

export const initializeIntegrationSetupSteps = initializeIntegrationSetupStepJournal;

// prettier-ignore
export type IntegrationSetupTransition = { status?: IntegrationSetupStatus; authStatus?: IntegrationAuthStatus; failureCode?: string | null; targetCredentialId?: string | null; targetCredentialEncryptedDataSha256?: string | null; credentialCreateAdditional?: boolean; oauthCredentialId?: string | null; oauthCreateAdditional?: boolean; step?: { id: string; status: IntegrationSetupStepStatus; failureCode?: string | null } };

function updateStep(
  step: StepRow,
  status: IntegrationSetupStepStatus,
  code: string | null,
  now: string
): void {
  const db = getDb();
  if (status === step.status) return;
  if (status === "active") {
    db.prepare(
      `UPDATE integration_setup_steps SET status = 'active', attempts = attempts + 1,
         failure_code = NULL, started_at = ?, completed_at = NULL, updated_at = ?
       WHERE flow_id = ? AND position = ?`
    ).run(now, now, step.flow_id, step.position);
    return;
  }
  if (status === "completed") {
    db.prepare(
      `UPDATE integration_setup_steps SET status = 'completed', failure_code = NULL,
         completed_at = ?, updated_at = ? WHERE flow_id = ? AND position = ?`
    ).run(now, now, step.flow_id, step.position);
    return;
  }
  if (status === "failed") {
    db.prepare(
      `UPDATE integration_setup_steps SET status = 'failed',
         attempts = attempts + CASE WHEN status = 'pending' THEN 1 ELSE 0 END,
         failure_code = ?, started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?
       WHERE flow_id = ? AND position = ?`
    ).run(code, now, now, now, step.flow_id, step.position);
    return;
  }
  throw new IntegrationSetupIllegalTransitionError("a setup step cannot return to pending");
}

/** Apply one optimistic flow/step transition; stale revisions roll back every journal write. */
export function transitionIntegrationSetupFlow(
  id: string,
  expectedRevision: number,
  transition: IntegrationSetupTransition
): IntegrationSetupFlowSnapshot {
  checkedRevision(expectedRevision);
  const db = getDb();
  db.transaction(() => {
    const flow = flowRow(id);
    if (flow.revision !== expectedRevision) conflict(expectedRevision, id);
    if (flow.status === "expired") flowExpired(flow);
    if (TERMINAL_FLOW_STATUSES.has(flow.status as IntegrationSetupStatus)) {
      throw new IntegrationSetupIllegalTransitionError(
        "terminal integration setup flow is immutable"
      );
    }
    const status = integrationSetupStatusSchema.parse(transition.status ?? flow.status);
    const wallClockNow = currentIso();
    if (Date.parse(wallClockNow) >= Date.parse(flow.expires_at) && status !== "expired") {
      flowExpired(flow);
    }
    const now = monotonicTimestamp(wallClockNow, flow.updated_at);
    const authStatus = integrationAuthStatusSchema.parse(transition.authStatus ?? flow.auth_status);
    checkAuthTransition(flow.auth_status as IntegrationAuthStatus, authStatus);
    const failureCode =
      transition.failureCode === undefined
        ? flow.failure_code
        : checkedFailureCode(transition.failureCode);
    let currentStep = flow.current_step;
    if (transition.step) {
      const stepId = integrationManifestIdSchema.parse(transition.step.id);
      const step = db
        .prepare(
          `SELECT flow_id, position, step_id, kind, status, attempts, failure_code,
                  started_at, completed_at
             FROM integration_setup_steps WHERE flow_id = ? AND step_id = ?`
        )
        .get(id, stepId) as StepRow | undefined;
      if (!step) throw new IntegrationSetupIllegalTransitionError(`setup step ${stepId} not found`);
      updateStep(
        step,
        transition.step.status,
        checkedFailureCode(transition.step.failureCode),
        now
      );
      if (transition.step.status === "active") currentStep = step.position;
    }
    const activeStep = stepsForFlow(id).find((step) => step.status === "active");
    if (status === "completed" && activeStep) {
      throw new IntegrationSetupIllegalTransitionError(
        "cannot complete a flow with an active step"
      );
    }
    if (activeStep && ["failed", "cancelled", "expired"].includes(status)) {
      const terminalCode =
        status === "cancelled"
          ? "flow_cancelled"
          : status === "expired"
            ? "flow_expired"
            : (failureCode ?? "flow_failed");
      updateStep(activeStep, "failed", terminalCode, now);
    }
    const targetCredentialId =
      transition.targetCredentialId === undefined
        ? flow.target_credential_id
        : transition.targetCredentialId === null
          ? null
          : identifier(transition.targetCredentialId, "target credential id");
    const targetCredentialEncryptedDataSha256 =
      targetCredentialId === null
        ? null
        : transition.targetCredentialEncryptedDataSha256 === undefined
          ? transition.targetCredentialId !== undefined &&
            transition.targetCredentialId !== flow.target_credential_id
            ? null
            : flow.target_credential_encrypted_data_sha256
          : transition.targetCredentialEncryptedDataSha256 === null
            ? null
            : checkedSha256(
                transition.targetCredentialEncryptedDataSha256,
                "target credential encrypted-data digest"
              );
    const credentialCreateAdditional =
      transition.credentialCreateAdditional === undefined
        ? targetCredentialId === null
          ? flow.credential_create_additional
          : 0
        : checkedBoolean(transition.credentialCreateAdditional, "credentialCreateAdditional")
          ? 1
          : 0;
    if (credentialCreateAdditional === 1 && targetCredentialId !== null) {
      throw new IntegrationSetupIllegalTransitionError(
        "create-additional approval cannot have a target credential"
      );
    }
    const oauthCredentialId =
      transition.oauthCredentialId === undefined
        ? flow.oauth_credential_id
        : transition.oauthCredentialId === null
          ? null
          : identifier(transition.oauthCredentialId, "OAuth credential id");
    const oauthCreateAdditional =
      transition.oauthCreateAdditional === undefined
        ? flow.oauth_create_additional
        : checkedBoolean(transition.oauthCreateAdditional, "oauthCreateAdditional")
          ? 1
          : 0;
    if (oauthCreateAdditional === 1 && oauthCredentialId !== null) {
      throw new IntegrationSetupIllegalTransitionError(
        "OAuth create-additional approval cannot have an OAuth credential"
      );
    }
    const completedAt = TERMINAL_FLOW_STATUSES.has(status) ? now : null;
    const updated = db
      .prepare(
        `UPDATE integration_setup_flows SET status = ?, auth_status = ?, current_step = ?,
           revision = revision + 1, failure_code = ?, target_credential_id = ?,
           target_credential_encrypted_data_sha256 = ?, credential_create_additional = ?,
           oauth_credential_id = ?, oauth_create_additional = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        status,
        authStatus,
        currentStep,
        failureCode,
        targetCredentialId,
        targetCredentialEncryptedDataSha256,
        credentialCreateAdditional,
        oauthCredentialId,
        oauthCreateAdditional,
        now,
        completedAt,
        id,
        expectedRevision
      );
    if (updated.changes !== 1) conflict(expectedRevision, id);
    if (TERMINAL_FLOW_STATUSES.has(status)) purgeIntegrationSetupSecretEnvelopes(id);
  }).immediate();
  return snapshotForFlowId(id);
}

function statusForStep(kind: IntegrationSetupStepKind): IntegrationSetupStatus {
  if (kind === "oauth") return "awaiting-oauth";
  if (kind === "diagnostic") return "discovering";
  return "awaiting-input";
}

/** Complete the active step and activate the next pending step in one CAS transaction. */
export function advanceIntegrationSetupFlow(
  id: string,
  expectedRevision: number
): IntegrationSetupFlowSnapshot {
  checkedRevision(expectedRevision);
  const db = getDb();
  db.transaction(() => {
    const flow = flowRow(id);
    if (flow.revision !== expectedRevision) conflict(expectedRevision, id);
    assertMutableFlow(flow);
    const now = monotonicTimestamp(currentIso(), flow.updated_at);
    const allSteps = stepsForFlow(id);
    const active = allSteps.find((step) => step.status === "active");
    if (active) updateStep(active, "completed", null, now);
    const next = allSteps.find(
      (step) => step.status === "pending" && (!active || step.position > active.position)
    );
    if (next) updateStep(next, "active", null, now);
    const status = next ? statusForStep(next.kind as IntegrationSetupStepKind) : "completed";
    const authStatus = flow.auth_status;
    const completedAt = TERMINAL_FLOW_STATUSES.has(status) ? now : null;
    const updated = db
      .prepare(
        `UPDATE integration_setup_flows SET status = ?, auth_status = ?, current_step = ?,
           revision = revision + 1, failure_code = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        status,
        authStatus,
        next?.position ?? flow.current_step,
        now,
        completedAt,
        id,
        expectedRevision
      );
    if (updated.changes !== 1) conflict(expectedRevision, id);
    if (TERMINAL_FLOW_STATUSES.has(status)) purgeIntegrationSetupSecretEnvelopes(id);
  }).immediate();
  return snapshotForFlowId(id);
}

/** Persist only duplicate credential IDs; safe summaries are joined when snapshots are read. */
export function setIntegrationSetupDuplicateCandidates(
  id: string,
  expectedRevision: number,
  credentialIds: readonly string[]
): IntegrationSetupFlowSnapshot {
  checkedRevision(expectedRevision);
  if (credentialIds.length > INTEGRATION_SETUP_LIMITS.duplicateCandidates) {
    throw new RangeError("too many duplicate credential candidates");
  }
  const ids = credentialIds.map((value) => identifier(value, "candidate credential id"));
  if (new Set(ids).size !== ids.length)
    throw new TypeError("candidate credential IDs must be unique");
  const db = getDb();
  db.transaction(() => {
    const flow = flowRow(id);
    if (flow.revision !== expectedRevision) conflict(expectedRevision, id);
    assertMutableFlow(flow);
    ids.forEach((credentialId) => {
      if (!candidateForId(flow, credentialId)) {
        throw new TypeError("candidate credential does not exist");
      }
    });
    const now = monotonicTimestamp(currentIso(), flow.updated_at);
    const updated = db
      .prepare(
        `UPDATE integration_setup_flows SET duplicate_candidate_ids = ?,
           revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`
      )
      .run(JSON.stringify(ids), now, id, expectedRevision);
    if (updated.changes !== 1) conflict(expectedRevision, id);
  }).immediate();
  return snapshotForFlowId(id);
}

/** Clear the persisted duplicate journal even when joined credential summaries disappeared. */
export function clearIntegrationSetupDuplicateCandidates(
  id: string,
  expectedRevision: number
): IntegrationSetupFlowSnapshot {
  checkedRevision(expectedRevision);
  const db = getDb();
  db.transaction(() => {
    const flow = flowRow(id);
    if (flow.revision !== expectedRevision) conflict(expectedRevision, id);
    assertMutableFlow(flow);
    const now = monotonicTimestamp(currentIso(), flow.updated_at);
    const updated = db
      .prepare(
        `UPDATE integration_setup_flows SET duplicate_candidate_ids = '[]',
           revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`
      )
      .run(now, id, expectedRevision);
    if (updated.changes !== 1) conflict(expectedRevision, id);
  }).immediate();
  return snapshotForFlowId(id);
}

export function cancelIntegrationSetupFlow(
  id: string,
  expectedRevision: number
): IntegrationSetupFlowSnapshot {
  return transitionIntegrationSetupFlow(id, expectedRevision, { status: "cancelled" });
}

export function expireIntegrationSetupFlow(
  id: string,
  expectedRevision: number,
  now = currentIso()
): IntegrationSetupFlowSnapshot {
  checkedRevision(expectedRevision);
  const flow = flowRow(id);
  if (flow.revision !== expectedRevision) conflict(expectedRevision, id);
  if (flow.status === "expired") flowExpired(flow);
  if (Date.parse(isoTimestamp(now, "now")) < Date.parse(flow.expires_at)) {
    throw new IntegrationSetupIllegalTransitionError("integration setup flow has not expired");
  }
  return transitionIntegrationSetupFlow(id, expectedRevision, { status: "expired" });
}

export function expireIntegrationSetupFlows(now = currentIso()): number {
  const cutoff = isoTimestamp(now, "now");
  const db = getDb();
  return db
    .transaction(() => {
      // Use the expiry index to remove short-lived envelopes even while their
      // owning flow remains active; no decryption is needed for cleanup.
      db.prepare("DELETE FROM integration_setup_secret_envelopes WHERE expires_at <= ?").run(
        cutoff
      );
      const rows = db
        .prepare(
          `SELECT id, revision, updated_at FROM integration_setup_flows
         WHERE status NOT IN ('completed', 'failed', 'cancelled', 'expired') AND expires_at <= ?`
        )
        .all(cutoff) as Array<{ id: string; revision: number; updated_at: string }>;
      for (const row of rows) {
        const persistedNow = monotonicTimestamp(cutoff, row.updated_at);
        db.prepare(
          `UPDATE integration_setup_steps SET status = 'failed', failure_code = 'flow_expired',
           started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?,
           attempts = attempts + CASE WHEN status = 'pending' THEN 1 ELSE 0 END
         WHERE flow_id = ? AND status = 'active'`
        ).run(persistedNow, persistedNow, persistedNow, row.id);
        db.prepare(
          `UPDATE integration_setup_flows SET status = 'expired', failure_code = 'flow_expired',
           revision = revision + 1, updated_at = ?, completed_at = ?
         WHERE id = ? AND revision = ?`
        ).run(persistedNow, persistedNow, row.id, row.revision);
        purgeIntegrationSetupSecretEnvelopes(row.id);
      }
      return rows.length;
    })
    .immediate();
}

export {
  consumeIntegrationSetupSecretEnvelopeByState,
  deleteIntegrationSetupSecretEnvelope,
  lookupIntegrationSetupSecretEnvelopeByState,
  putIntegrationSetupSecretEnvelope,
  readIntegrationSetupSecretEnvelope,
  type IntegrationSetupSecretEnvelope,
  type IntegrationSetupSecretEnvelopeMetadata,
  type IntegrationSetupSecretPurpose,
  type PutIntegrationSetupSecretEnvelopeInput,
} from "./integration-setup-secret-store.ts";
export * from "./integration-credential-binding-store.ts";
