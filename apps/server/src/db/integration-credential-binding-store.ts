import { createHash } from "node:crypto";
import {
  integrationAuthStatusSchema,
  integrationManifestIdSchema,
  integrationManifestSemverSchema,
  integrationSetupFailureCodeSchema,
  type IntegrationAuthStatus,
  type IntegrationSetupFailureCode,
} from "@chvor/shared";
import { getDb } from "./database.ts";
import { IntegrationSetupIllegalTransitionError } from "./integration-setup-errors.ts";

const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type IntegrationCredentialAuthMethod =
  | "credential"
  | "api-key"
  | "basic"
  | "bearer"
  | "oauth"
  | "oauth2"
  | "service-account"
  | "custom";

// prettier-ignore
export type IntegrationCredentialBindingKey = { credentialId: string; integrationId: string; manifestCredentialId: string };
// prettier-ignore
export type UpsertIntegrationCredentialBindingInput = IntegrationCredentialBindingKey & { manifestId?: string; manifestVersion: string; authMethod: IntegrationCredentialAuthMethod; authStatus?: IntegrationAuthStatus; failureCode?: string | null; tokenExpiresAt?: string | null; scopes?: readonly string[]; accountFingerprint?: string | null; accountFingerprintSource?: string; accountLabel?: string | null; authCheckedAt?: string | null };
// prettier-ignore
export type IntegrationCredentialBinding = IntegrationCredentialBindingKey & { manifestId: string; manifestVersion: string; authMethod: IntegrationCredentialAuthMethod; authStatus: IntegrationAuthStatus; failureCode?: IntegrationSetupFailureCode; tokenExpiresAt?: string; scopes: string[]; accountFingerprint?: string; accountLabel?: string; createdAt: string; updatedAt: string; authCheckedAt?: string };
// prettier-ignore
type BindingRow = { credential_id: string; integration_id: string; manifest_id: string; manifest_version: string; manifest_credential_id: string; auth_method: string; auth_status: string; failure_code: string | null; token_expires_at: string | null; scopes: string; account_fingerprint: string | null; account_label: string | null; created_at: string; updated_at: string; auth_checked_at: string | null };

const BINDING_COLUMNS = `credential_id, integration_id, manifest_id, manifest_version,
  manifest_credential_id, auth_method, auth_status, failure_code, token_expires_at,
  scopes, account_fingerprint, account_label, created_at, updated_at, auth_checked_at`;

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

function authMethod(value: string): IntegrationCredentialAuthMethod {
  const methods: IntegrationCredentialAuthMethod[] = [
    "credential",
    "api-key",
    "basic",
    "bearer",
    "oauth",
    "oauth2",
    "service-account",
    "custom",
  ];
  if (!methods.includes(value as IntegrationCredentialAuthMethod)) {
    throw new TypeError("invalid auth method");
  }
  return value as IntegrationCredentialAuthMethod;
}

function checkedScopes(values: readonly string[]): string[] {
  if (values.length > 128) throw new RangeError("too many OAuth scopes");
  const scopes = values.map((scope) => {
    if (!scope || scope.length > 1024 || CONTROL_CHARACTER.test(scope)) {
      throw new TypeError("OAuth scope must be a bounded string without control characters");
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) throw new TypeError("OAuth scopes must be unique");
  return scopes;
}

function checkedAccountLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 320 || CONTROL_CHARACTER.test(normalized)) {
    throw new TypeError("account label must be a bounded display string");
  }
  return normalized;
}

export function hashIntegrationAccountFingerprint(
  integrationId: string,
  accountIdentifier: string
): string {
  const normalizedId = integrationManifestIdSchema.parse(integrationId);
  if (
    !accountIdentifier ||
    accountIdentifier.length > 4096 ||
    CONTROL_CHARACTER.test(accountIdentifier)
  ) {
    throw new TypeError("account identifier must be a bounded string without control characters");
  }
  return createHash("sha256")
    .update(normalizedId, "utf8")
    .update("\0")
    .update(accountIdentifier.trim(), "utf8")
    .digest("hex");
}

function bindingFromRow(row: BindingRow): IntegrationCredentialBinding {
  const scopes = checkedScopes(JSON.parse(row.scopes) as unknown as string[]);
  return {
    credentialId: identifier(row.credential_id, "credential id"),
    integrationId: integrationManifestIdSchema.parse(row.integration_id),
    manifestId: integrationManifestIdSchema.parse(row.manifest_id),
    manifestVersion: integrationManifestSemverSchema.parse(row.manifest_version),
    manifestCredentialId: integrationManifestIdSchema.parse(row.manifest_credential_id),
    authMethod: authMethod(row.auth_method),
    authStatus: integrationAuthStatusSchema.parse(row.auth_status),
    ...(row.failure_code
      ? { failureCode: integrationSetupFailureCodeSchema.parse(row.failure_code) }
      : {}),
    ...(row.token_expires_at
      ? { tokenExpiresAt: isoTimestamp(row.token_expires_at, "token expiry") }
      : {}),
    scopes,
    ...(row.account_fingerprint ? { accountFingerprint: row.account_fingerprint } : {}),
    ...(row.account_label
      ? { accountLabel: checkedAccountLabel(row.account_label) ?? undefined }
      : {}),
    createdAt: isoTimestamp(row.created_at, "created timestamp"),
    updatedAt: isoTimestamp(row.updated_at, "updated timestamp"),
    ...(row.auth_checked_at
      ? { authCheckedAt: isoTimestamp(row.auth_checked_at, "auth timestamp") }
      : {}),
  };
}

function normalizedBindingKey(
  key: IntegrationCredentialBindingKey
): IntegrationCredentialBindingKey {
  return {
    credentialId: identifier(key.credentialId, "credential id"),
    integrationId: integrationManifestIdSchema.parse(key.integrationId),
    manifestCredentialId: integrationManifestIdSchema.parse(key.manifestCredentialId),
  };
}

/** Adopt an existing credential by metadata-only ID reference; credential ciphertext is untouched. */
export function upsertIntegrationCredentialBinding(
  input: UpsertIntegrationCredentialBindingInput
): IntegrationCredentialBinding {
  const key = normalizedBindingKey(input);
  const db = getDb();
  const exists = db.prepare("SELECT id FROM credentials WHERE id = ?").get(key.credentialId);
  if (!exists) throw new TypeError(`credential ${key.credentialId} does not exist`);
  const manifestId = integrationManifestIdSchema.parse(input.manifestId ?? key.integrationId);
  const manifestVersion = integrationManifestSemverSchema.parse(input.manifestVersion);
  const method = authMethod(input.authMethod);
  const status = integrationAuthStatusSchema.parse(input.authStatus ?? "unknown");
  const failureCode = checkedFailureCode(input.failureCode);
  if (status === "active" && failureCode) {
    throw new TypeError("active binding cannot have a failure code");
  }
  const tokenExpiresAt = input.tokenExpiresAt
    ? isoTimestamp(input.tokenExpiresAt, "tokenExpiresAt")
    : null;
  const scopes = checkedScopes(input.scopes ?? []);
  const accountFingerprint = input.accountFingerprintSource
    ? hashIntegrationAccountFingerprint(key.integrationId, input.accountFingerprintSource)
    : input.accountFingerprint == null
      ? null
      : input.accountFingerprint;
  if (accountFingerprint !== null && !SHA256_HEX.test(accountFingerprint)) {
    throw new TypeError("account fingerprint must be a SHA-256 digest");
  }
  const accountLabel = checkedAccountLabel(input.accountLabel);
  const now = currentIso();
  const authCheckedAt = input.authCheckedAt
    ? monotonicTimestamp(isoTimestamp(input.authCheckedAt, "authCheckedAt"), now)
    : null;
  db.prepare(
    `INSERT INTO integration_credential_bindings
       (credential_id, integration_id, manifest_id, manifest_version,
        manifest_credential_id, auth_method, auth_status, failure_code,
        token_expires_at, scopes, account_fingerprint, account_label,
        created_at, updated_at, auth_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_id, integration_id, manifest_credential_id) DO UPDATE SET
       manifest_id = excluded.manifest_id,
       manifest_version = excluded.manifest_version,
       auth_method = excluded.auth_method,
       auth_status = excluded.auth_status,
       failure_code = excluded.failure_code,
       token_expires_at = excluded.token_expires_at,
       scopes = excluded.scopes,
       account_fingerprint = excluded.account_fingerprint,
       account_label = excluded.account_label,
       updated_at = CASE
         WHEN julianday(excluded.updated_at) >=
              julianday(integration_credential_bindings.updated_at)
         THEN excluded.updated_at
         ELSE integration_credential_bindings.updated_at
       END,
       auth_checked_at = CASE
         WHEN excluded.auth_checked_at IS NULL
         THEN integration_credential_bindings.auth_checked_at
         WHEN julianday(excluded.auth_checked_at) >= julianday(COALESCE(
           integration_credential_bindings.auth_checked_at,
           integration_credential_bindings.created_at
         ))
         THEN excluded.auth_checked_at
         ELSE COALESCE(
           integration_credential_bindings.auth_checked_at,
           integration_credential_bindings.created_at
         )
       END`
  ).run(
    key.credentialId,
    key.integrationId,
    manifestId,
    manifestVersion,
    key.manifestCredentialId,
    method,
    status,
    failureCode,
    tokenExpiresAt,
    JSON.stringify(scopes),
    accountFingerprint,
    accountLabel,
    now,
    now,
    authCheckedAt
  );
  return getIntegrationCredentialBinding(key) as IntegrationCredentialBinding;
}

export function getIntegrationCredentialBinding(
  key: IntegrationCredentialBindingKey
): IntegrationCredentialBinding | null {
  const normalized = normalizedBindingKey(key);
  const row = getDb()
    .prepare(
      `SELECT ${BINDING_COLUMNS} FROM integration_credential_bindings
       WHERE credential_id = ? AND integration_id = ? AND manifest_credential_id = ?`
    )
    .get(normalized.credentialId, normalized.integrationId, normalized.manifestCredentialId) as
    | BindingRow
    | undefined;
  return row ? bindingFromRow(row) : null;
}

/** List safe binding metadata for one credential without reading credential ciphertext. */
export function listIntegrationCredentialBindingsForCredential(
  credentialId: string
): IntegrationCredentialBinding[] {
  const rows = getDb()
    .prepare(
      `SELECT ${BINDING_COLUMNS} FROM integration_credential_bindings
       WHERE credential_id = ?
       ORDER BY integration_id ASC, manifest_credential_id ASC`
    )
    .all(identifier(credentialId, "credential id")) as BindingRow[];
  return rows.map(bindingFromRow);
}

export const readIntegrationCredentialBinding = getIntegrationCredentialBinding;
export const updateIntegrationCredentialBinding = upsertIntegrationCredentialBinding;

// prettier-ignore
export type UpdateIntegrationCredentialAuthStateInput = { authStatus: IntegrationAuthStatus; failureCode?: string | null; tokenExpiresAt?: string | null; scopes?: readonly string[]; authCheckedAt?: string };

export function updateIntegrationCredentialAuthState(
  key: IntegrationCredentialBindingKey,
  input: UpdateIntegrationCredentialAuthStateInput
): IntegrationCredentialBinding {
  const normalized = normalizedBindingKey(key);
  const current = getIntegrationCredentialBinding(normalized);
  if (!current) throw new TypeError("integration credential binding does not exist");
  const status = integrationAuthStatusSchema.parse(input.authStatus);
  checkAuthTransition(current.authStatus, status);
  const failureCode = checkedFailureCode(input.failureCode);
  if (status === "active" && failureCode) {
    throw new TypeError("active binding cannot have a failure code");
  }
  const tokenExpiresAt =
    input.tokenExpiresAt === undefined
      ? (current.tokenExpiresAt ?? null)
      : input.tokenExpiresAt === null
        ? null
        : isoTimestamp(input.tokenExpiresAt, "tokenExpiresAt");
  const scopes = input.scopes ? checkedScopes(input.scopes) : current.scopes;
  const authCheckedAt = monotonicTimestamp(
    isoTimestamp(input.authCheckedAt ?? currentIso(), "authCheckedAt"),
    current.authCheckedAt ?? current.createdAt
  );
  const now = monotonicTimestamp(currentIso(), current.updatedAt);
  const updated = getDb()
    .prepare(
      `UPDATE integration_credential_bindings SET auth_status = ?, failure_code = ?,
         token_expires_at = ?, scopes = ?, auth_checked_at = ?, updated_at = ?
       WHERE credential_id = ? AND integration_id = ? AND manifest_credential_id = ?`
    )
    .run(
      status,
      failureCode,
      tokenExpiresAt,
      JSON.stringify(scopes),
      authCheckedAt,
      now,
      normalized.credentialId,
      normalized.integrationId,
      normalized.manifestCredentialId
    );
  if (updated.changes !== 1) throw new TypeError("integration credential binding does not exist");
  return getIntegrationCredentialBinding(normalized) as IntegrationCredentialBinding;
}

export const updateIntegrationCredentialBindingAuthState = updateIntegrationCredentialAuthState;
