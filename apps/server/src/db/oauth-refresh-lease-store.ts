import { randomBytes } from "node:crypto";
import { getDb } from "./database.ts";

export const OAUTH_REFRESH_LEASE_TTL_MS = 60_000;

const MAX_CREDENTIAL_ID_LENGTH = 256;
const LEASE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

type LeaseRow = { lease_id: string; expires_at: string };

interface LeaseVersion extends LeaseRow {
  acquired_at: string;
}

interface LeaseObservation extends LeaseVersion {
  observedAt: number;
}

export interface OAuthRefreshLeaseClock {
  wallNow(): number;
  monotonicNow(): number;
}

export type OAuthRefreshLeaseAcquisition =
  | { outcome: "acquired"; leaseId: string; expiresAt: string }
  | { outcome: "contended"; expiresAt: string }
  | { outcome: "not-found" };

const systemClock: OAuthRefreshLeaseClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};
let leaseClock = systemClock;
const leaseObservations = new Map<string, LeaseObservation>();

function checkedCredentialId(credentialId: string): string {
  if (!credentialId || credentialId.length > MAX_CREDENTIAL_ID_LENGTH) {
    throw new TypeError("OAuth refresh lease credential ID must be bounded");
  }
  return credentialId;
}

function checkedLeaseId(leaseId: string): string {
  if (!LEASE_ID_PATTERN.test(leaseId)) {
    throw new TypeError("OAuth refresh lease ID is invalid");
  }
  return leaseId;
}

function checkedTimestamp(now: number): string {
  if (!Number.isFinite(now)) throw new TypeError("OAuth refresh lease time is invalid");
  return new Date(now).toISOString();
}

function checkedMonotonicTime(now: number): number {
  if (!Number.isFinite(now)) {
    throw new TypeError("OAuth refresh lease monotonic time is invalid");
  }
  return now;
}

function wallNow(): number {
  return leaseClock.wallNow();
}

export function getOAuthRefreshLeaseMonotonicTime(): number {
  return checkedMonotonicTime(leaseClock.monotonicNow());
}

/** Replace both clocks for deterministic discontinuity tests. */
export function _setOAuthRefreshLeaseClockForTests(
  clock: OAuthRefreshLeaseClock
): () => void {
  const previous = leaseClock;
  leaseClock = clock;
  leaseObservations.clear();
  return () => {
    if (leaseClock === clock) leaseClock = previous;
    leaseObservations.clear();
  };
}

function newLeaseId(): string {
  return randomBytes(24).toString("base64url");
}

function sameLeaseVersion(left: LeaseVersion, right: LeaseVersion): boolean {
  return (
    left.lease_id === right.lease_id &&
    left.acquired_at === right.acquired_at &&
    left.expires_at === right.expires_at
  );
}

function observeLeaseVersion(
  credentialId: string,
  holder: LeaseVersion,
  monotonicNow: number
): LeaseObservation {
  const previous = leaseObservations.get(credentialId);
  if (
    previous &&
    sameLeaseVersion(previous, holder) &&
    monotonicNow >= previous.observedAt
  ) {
    return previous;
  }
  const observed = { ...holder, observedAt: monotonicNow };
  leaseObservations.set(credentialId, observed);
  return observed;
}

/**
 * Acquire the per-credential lease. A holder must remain byte-for-byte stable
 * for one monotonic TTL before it can be reclaimed, so wall-clock jumps cannot
 * make a live cross-process holder disappear immediately.
 */
export function acquireOAuthRefreshLease(
  credentialId: string,
  now = wallNow()
): OAuthRefreshLeaseAcquisition {
  const boundedCredentialId = checkedCredentialId(credentialId);
  const acquiredAt = checkedTimestamp(now);
  const expiresAt = checkedTimestamp(now + OAUTH_REFRESH_LEASE_TTL_MS);
  const monotonicNow = getOAuthRefreshLeaseMonotonicTime();
  const leaseId = newLeaseId();
  const db = getDb();

  return db
    .transaction((): OAuthRefreshLeaseAcquisition => {
      const holder = db
        .prepare(
          `SELECT lease_id, acquired_at, expires_at FROM oauth_refresh_leases
           WHERE credential_id = ?`
        )
        .get(boundedCredentialId) as LeaseVersion | undefined;
      if (holder) {
        const observed = observeLeaseVersion(boundedCredentialId, holder, monotonicNow);
        if (monotonicNow - observed.observedAt < OAUTH_REFRESH_LEASE_TTL_MS) {
          return { outcome: "contended", expiresAt: holder.expires_at };
        }

        const reclaimed = db
          .prepare(
            `DELETE FROM oauth_refresh_leases
             WHERE credential_id = ? AND lease_id = ? AND acquired_at = ? AND expires_at = ?`
          )
          .run(
            boundedCredentialId,
            observed.lease_id,
            observed.acquired_at,
            observed.expires_at
          );
        if (reclaimed.changes !== 1) {
          const current = db
            .prepare(
              `SELECT lease_id, acquired_at, expires_at FROM oauth_refresh_leases
               WHERE credential_id = ?`
            )
            .get(boundedCredentialId) as LeaseVersion | undefined;
          if (!current) {
            leaseObservations.delete(boundedCredentialId);
            return { outcome: "not-found" };
          }
          observeLeaseVersion(boundedCredentialId, current, monotonicNow);
          return { outcome: "contended", expiresAt: current.expires_at };
        }
        leaseObservations.delete(boundedCredentialId);
      } else {
        leaseObservations.delete(boundedCredentialId);
      }

      const credential = db
        .prepare("SELECT 1 FROM credentials WHERE id = ?")
        .get(boundedCredentialId);
      if (!credential) return { outcome: "not-found" };

      const inserted = db
        .prepare(
          `INSERT INTO oauth_refresh_leases (credential_id, lease_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(credential_id) DO NOTHING`
        )
        .run(boundedCredentialId, leaseId, acquiredAt, expiresAt);
      if (inserted.changes === 1) return { outcome: "acquired", leaseId, expiresAt };

      const currentHolder = db
        .prepare("SELECT lease_id, expires_at FROM oauth_refresh_leases WHERE credential_id = ?")
        .get(boundedCredentialId) as LeaseRow | undefined;
      return currentHolder
        ? { outcome: "contended", expiresAt: currentHolder.expires_at }
        : { outcome: "not-found" };
    })
    .immediate();
}

/** Renew only the exact holder version; a replacement lease can never be resurrected. */
export function renewOAuthRefreshLease(leaseId: string, now = wallNow()): boolean {
  const boundedLeaseId = checkedLeaseId(leaseId);
  checkedTimestamp(now);
  const db = getDb();
  return db
    .transaction(() => {
      const holder = db
        .prepare("SELECT expires_at FROM oauth_refresh_leases WHERE lease_id = ?")
        .get(boundedLeaseId) as Pick<LeaseRow, "expires_at"> | undefined;
      if (!holder) return false;
      const currentExpiry = Date.parse(holder.expires_at);
      const expiresAt = checkedTimestamp(
        Math.max(now + OAUTH_REFRESH_LEASE_TTL_MS, currentExpiry + 1)
      );
      const result = db
        .prepare(
          `UPDATE oauth_refresh_leases SET expires_at = ?
           WHERE lease_id = ? AND expires_at = ?`
        )
        .run(expiresAt, boundedLeaseId, holder.expires_at);
      return result.changes === 1;
    })
    .immediate();
}

/** Check ownership inside a surrounding write transaction before committing protected state. */
export function isOAuthRefreshLeaseHeld(leaseId: string, now = wallNow()): boolean {
  checkedTimestamp(now);
  const row = getDb()
    .prepare("SELECT 1 FROM oauth_refresh_leases WHERE lease_id = ?")
    .get(checkedLeaseId(leaseId));
  return !!row;
}

/** Release by the unguessable holder ID so a stale owner cannot delete a replacement lease. */
export function releaseOAuthRefreshLease(leaseId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM oauth_refresh_leases WHERE lease_id = ?")
    .run(checkedLeaseId(leaseId));
  return result.changes === 1;
}
