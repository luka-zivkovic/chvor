import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-oauth-refresh-lease-"));
process.env.CHVOR_DATA_DIR = dataDir;

let credentials: typeof import("../credential-store.ts");
let leases: typeof import("../oauth-refresh-lease-store.ts");
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;
let wallNow = Date.parse("2026-01-01T00:00:00.000Z");
let monotonicNow = 0;
let restoreClock: (() => void) | undefined;

beforeAll(async () => {
  credentials = await import("../credential-store.ts");
  leases = await import("../oauth-refresh-lease-store.ts");
  ({ getDb, closeDb } = await import("../database.ts"));
});

beforeEach(() => {
  getDb().prepare("DELETE FROM credentials").run();
  wallNow = Date.parse("2026-01-01T00:00:00.000Z");
  monotonicNow = 0;
  restoreClock = leases._setOAuthRefreshLeaseClockForTests({
    wallNow: () => wallNow,
    monotonicNow: () => monotonicNow,
  });
});

afterEach(() => restoreClock?.());

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("OAuth refresh lease store", () => {
  it("grants one metadata-only lease per credential and releases by opaque holder ID", () => {
    const credential = credentials.createCredential("OAuth", "oauth-token-demo", {
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
    });
    const first = leases.acquireOAuthRefreshLease(credential.id);
    expect(first).toMatchObject({ outcome: "acquired" });
    wallNow += 1;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toEqual({
      outcome: "contended",
      expiresAt: new Date(
        Date.parse("2026-01-01T00:00:00.000Z") + leases.OAUTH_REFRESH_LEASE_TTL_MS
      ).toISOString(),
    });

    const columns = getDb().pragma("table_info(oauth_refresh_leases)") as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      "credential_id",
      "lease_id",
      "acquired_at",
      "expires_at",
    ]);
    const raw = getDb().prepare("SELECT * FROM oauth_refresh_leases").get();
    expect(JSON.stringify(raw)).not.toContain("secret-access");
    expect(JSON.stringify(raw)).not.toContain("secret-refresh");

    if (first.outcome !== "acquired") throw new Error("expected acquired lease");
    expect(leases.isOAuthRefreshLeaseHeld(first.leaseId)).toBe(true);
    wallNow += 1_000;
    expect(leases.renewOAuthRefreshLease(first.leaseId)).toBe(true);
    wallNow += 24 * 60 * 60 * 1_000;
    expect(leases.isOAuthRefreshLeaseHeld(first.leaseId)).toBe(true);
    expect(leases.releaseOAuthRefreshLease("A".repeat(32))).toBe(false);
    expect(leases.releaseOAuthRefreshLease(first.leaseId)).toBe(true);
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "acquired",
    });
  });

  it("reclaims only after one monotonic TTL of an exact stable holder version", () => {
    const credential = credentials.createCredential("OAuth", "oauth-token-demo", {
      refreshToken: "secret-refresh",
    });
    const first = leases.acquireOAuthRefreshLease(credential.id);
    if (first.outcome !== "acquired") throw new Error("expected acquired lease");

    wallNow += 24 * 60 * 60 * 1_000;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS - 1;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS;
    const replacement = leases.acquireOAuthRefreshLease(credential.id);
    expect(replacement).toMatchObject({ outcome: "acquired" });
    if (replacement.outcome !== "acquired") throw new Error("expected replacement lease");
    expect(replacement.leaseId).not.toBe(first.leaseId);

    expect(leases.renewOAuthRefreshLease(first.leaseId)).toBe(false);
    expect(leases.isOAuthRefreshLeaseHeld(first.leaseId)).toBe(false);
    wallNow -= 48 * 60 * 60 * 1_000;
    expect(leases.isOAuthRefreshLeaseHeld(replacement.leaseId)).toBe(true);
    expect(leases.releaseOAuthRefreshLease(first.leaseId)).toBe(false);
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    expect(leases.releaseOAuthRefreshLease(replacement.leaseId)).toBe(true);
  });

  it("does not let a forward wall jump reclaim a holder that keeps renewing", () => {
    const credential = credentials.createCredential("OAuth", "oauth-token-demo", {
      refreshToken: "secret-refresh",
    });
    const holder = leases.acquireOAuthRefreshLease(credential.id);
    if (holder.outcome !== "acquired") throw new Error("expected acquired lease");

    wallNow += 7 * 24 * 60 * 60 * 1_000;
    monotonicNow = 1;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });

    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS + 1;
    expect(leases.renewOAuthRefreshLease(holder.leaseId)).toBe(true);
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS * 2;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS * 2 + 1;
    const replacement = leases.acquireOAuthRefreshLease(credential.id);
    expect(replacement).toMatchObject({ outcome: "acquired" });
    expect(leases.renewOAuthRefreshLease(holder.leaseId)).toBe(false);
    expect(leases.releaseOAuthRefreshLease(holder.leaseId)).toBe(false);
  });

  it("bounds reclaim under a backward wall jump while renewal resets the stability window", () => {
    const credential = credentials.createCredential("OAuth", "oauth-token-demo", {
      refreshToken: "secret-refresh",
    });
    const holder = leases.acquireOAuthRefreshLease(credential.id);
    if (holder.outcome !== "acquired") throw new Error("expected acquired lease");
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });

    wallNow -= 30 * 24 * 60 * 60 * 1_000;
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS - 1;
    expect(leases.renewOAuthRefreshLease(holder.leaseId)).toBe(true);
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS * 2 - 1;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "contended",
    });
    monotonicNow = leases.OAUTH_REFRESH_LEASE_TTL_MS * 2;
    expect(leases.acquireOAuthRefreshLease(credential.id)).toMatchObject({
      outcome: "acquired",
    });
  });
});
