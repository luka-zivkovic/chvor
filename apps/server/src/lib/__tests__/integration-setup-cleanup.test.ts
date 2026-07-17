import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-integration-setup-cleanup-"));
process.env.CHVOR_DATA_DIR = dataDir;

let cleanup: typeof import("../integration-setup-cleanup.ts");
let store: typeof import("../../db/integration-setup-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

beforeAll(async () => {
  cleanup = await import("../integration-setup-cleanup.ts");
  store = await import("../../db/integration-setup-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

afterEach(() => {
  cleanup.stopIntegrationSetupCleanup();
  vi.useRealTimers();
  getDb().prepare("DELETE FROM integration_setup_flows").run();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("integration setup background cleanup", () => {
  it("expires abandoned flows and envelopes without a setup read", async () => {
    const start = new Date("2026-07-13T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const flow = store.createIntegrationSetupFlow({
      integrationId: "provider.cleanup",
      manifestVersion: "1.0.0",
      manifestCredentialId: "credential.cleanup",
      credentialType: "cleanup",
      mode: "setup",
      expiresAt: new Date(start.getTime() + 30_000).toISOString(),
    });
    store.putIntegrationSetupSecretEnvelope({
      flowId: flow.id,
      purpose: "pkce",
      state: "cleanup-state",
      payload: "cleanup-secret",
    });

    cleanup.startIntegrationSetupCleanup();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(
      getDb().prepare("SELECT status FROM integration_setup_flows WHERE id = ?").get(flow.id)
    ).toEqual({ status: "expired" });
    expect(
      getDb()
        .prepare(
          "SELECT count(*) AS count FROM integration_setup_secret_envelopes WHERE flow_id = ?"
        )
        .get(flow.id)
    ).toEqual({ count: 0 });
  });
});
