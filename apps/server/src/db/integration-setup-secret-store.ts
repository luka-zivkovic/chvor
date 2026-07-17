import { createHash, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "./crypto.ts";
import { getDb } from "./database.ts";
import {
  IntegrationSetupFlowExpiredError,
  IntegrationSetupFlowNotFoundError,
  IntegrationSetupIllegalTransitionError,
} from "./integration-setup-errors.ts";

const DEFAULT_ENVELOPE_TTL_MS = 10 * 60 * 1_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const TERMINAL_FLOW_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);

export type IntegrationSetupSecretPurpose = "pkce" | "staged-oauth" | "staged-credential";

// prettier-ignore
export type PutIntegrationSetupSecretEnvelopeInput = { id?: string; flowId: string; purpose: IntegrationSetupSecretPurpose; payload: string; state?: string; expiresAt?: string };
// prettier-ignore
export type IntegrationSetupSecretEnvelopeMetadata = { id: string; flowId: string; purpose: IntegrationSetupSecretPurpose; expiresAt: string };
export type IntegrationSetupSecretEnvelope = IntegrationSetupSecretEnvelopeMetadata & {
  payload: string;
};

// prettier-ignore
type FlowSecretRow = { id: string; status: string; expires_at: string };
// prettier-ignore
type EnvelopeRow = { id: string; flow_id: string; purpose: string; encrypted_payload: string; expires_at: string };

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

function secretPurpose(value: string): IntegrationSetupSecretPurpose {
  if (!["pkce", "staged-oauth", "staged-credential"].includes(value)) {
    throw new TypeError("invalid integration setup secret purpose");
  }
  return value as IntegrationSetupSecretPurpose;
}

function stateHash(state: string): string {
  if (state.length < 1 || state.length > 4096 || CONTROL_CHARACTER.test(state)) {
    throw new TypeError("OAuth state must be a bounded string without control characters");
  }
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function mutableFlow(flowId: string): FlowSecretRow {
  const row = getDb()
    .prepare("SELECT id, status, expires_at FROM integration_setup_flows WHERE id = ?")
    .get(identifier(flowId, "flow id")) as FlowSecretRow | undefined;
  if (!row) {
    throw new IntegrationSetupFlowNotFoundError(`integration setup flow ${flowId} not found`);
  }
  if (row.status === "expired" || Date.parse(row.expires_at) <= Date.now()) {
    throw new IntegrationSetupFlowExpiredError(`integration setup flow ${flowId} has expired`);
  }
  if (TERMINAL_FLOW_STATUSES.has(row.status)) {
    throw new IntegrationSetupIllegalTransitionError(
      "terminal integration setup flow is immutable"
    );
  }
  return row;
}

/** Encrypt and replace the single envelope for a flow/purpose without exposing ciphertext. */
export function putIntegrationSetupSecretEnvelope(
  input: PutIntegrationSetupSecretEnvelopeInput
): IntegrationSetupSecretEnvelopeMetadata {
  const purpose = secretPurpose(input.purpose);
  if (purpose === "staged-credential" && input.state !== undefined) {
    throw new TypeError("staged credential envelope cannot have OAuth state");
  }
  if (Buffer.byteLength(input.payload, "utf8") > 1_048_576) {
    throw new RangeError("secret envelope payload exceeds 1 MiB");
  }
  const id = input.id ? identifier(input.id, "secret envelope id") : randomUUID();
  const now = currentIso();
  const encryptedPayload = encrypt(input.payload);
  const hash = input.state === undefined ? null : stateHash(input.state);
  const db = getDb();
  return db
    .transaction(() => {
      const flow = mutableFlow(input.flowId);
      const expiresAt = input.expiresAt
        ? isoTimestamp(input.expiresAt, "expiresAt")
        : new Date(
            Math.min(Date.parse(flow.expires_at), Date.parse(now) + DEFAULT_ENVELOPE_TTL_MS)
          ).toISOString();
      if (
        Date.parse(expiresAt) <= Date.parse(now) ||
        Date.parse(expiresAt) > Date.parse(flow.expires_at)
      ) {
        throw new RangeError(
          "secret envelope expiry must be after now and no later than flow expiry"
        );
      }
      db.prepare(
        "DELETE FROM integration_setup_secret_envelopes WHERE flow_id = ? AND purpose = ?"
      ).run(flow.id, purpose);
      db.prepare(
        `INSERT INTO integration_setup_secret_envelopes
         (id, flow_id, purpose, encrypted_payload, state_sha256, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, flow.id, purpose, encryptedPayload, hash, now, expiresAt);
      return { id, flowId: flow.id, purpose, expiresAt };
    })
    .immediate();
}

function readEnvelopeRow(
  row: EnvelopeRow | undefined,
  now: string
): IntegrationSetupSecretEnvelope | null {
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.parse(now)) {
    getDb().prepare("DELETE FROM integration_setup_secret_envelopes WHERE id = ?").run(row.id);
    return null;
  }
  return {
    id: row.id,
    flowId: row.flow_id,
    purpose: secretPurpose(row.purpose),
    payload: decrypt(row.encrypted_payload),
    expiresAt: row.expires_at,
  };
}

export function readIntegrationSetupSecretEnvelope(
  id: string,
  now = currentIso()
): IntegrationSetupSecretEnvelope | null {
  const row = getDb()
    .prepare(
      `SELECT id, flow_id, purpose, encrypted_payload, expires_at
       FROM integration_setup_secret_envelopes WHERE id = ?`
    )
    .get(identifier(id, "secret envelope id")) as EnvelopeRow | undefined;
  return readEnvelopeRow(row, isoTimestamp(now, "now"));
}

export function lookupIntegrationSetupSecretEnvelopeByState(
  state: string,
  now = currentIso()
): IntegrationSetupSecretEnvelope | null {
  const row = getDb()
    .prepare(
      `SELECT id, flow_id, purpose, encrypted_payload, expires_at
       FROM integration_setup_secret_envelopes WHERE state_sha256 = ?`
    )
    .get(stateHash(state)) as EnvelopeRow | undefined;
  return readEnvelopeRow(row, isoTimestamp(now, "now"));
}

/** Atomically claim and delete a one-time state envelope across processes. */
export function consumeIntegrationSetupSecretEnvelopeByState(
  state: string,
  expectedPurpose: IntegrationSetupSecretPurpose,
  now = currentIso()
): IntegrationSetupSecretEnvelope | null {
  const hash = stateHash(state);
  const purpose = secretPurpose(expectedPurpose);
  const checkedNow = isoTimestamp(now, "now");
  const db = getDb();
  return db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT id, flow_id, purpose, encrypted_payload, expires_at
         FROM integration_setup_secret_envelopes WHERE state_sha256 = ? AND purpose = ?`
        )
        .get(hash, purpose) as EnvelopeRow | undefined;
      if (!row) return null;
      const deleted = db
        .prepare(
          `DELETE FROM integration_setup_secret_envelopes
         WHERE id = ? AND state_sha256 = ? AND purpose = ? AND expires_at > ?`
        )
        .run(row.id, hash, purpose, checkedNow);
      if (deleted.changes !== 1) {
        db.prepare("DELETE FROM integration_setup_secret_envelopes WHERE id = ?").run(row.id);
        return null;
      }
      return {
        id: row.id,
        flowId: row.flow_id,
        purpose: secretPurpose(row.purpose),
        payload: decrypt(row.encrypted_payload),
        expiresAt: row.expires_at,
      };
    })
    .immediate();
}

export function deleteIntegrationSetupSecretEnvelope(id: string): boolean {
  return (
    getDb()
      .prepare("DELETE FROM integration_setup_secret_envelopes WHERE id = ?")
      .run(identifier(id, "secret envelope id")).changes === 1
  );
}
