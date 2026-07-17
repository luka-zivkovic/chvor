import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const composio = vi.hoisted(() => ({
  initiate: vi.fn(),
  list: vi.fn(),
  disconnect: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("../../lib/composio-client.ts", () => ({
  initiateConnection: composio.initiate,
  listConnectedAccounts: composio.list,
  disconnectAccount: composio.disconnect,
  verifyConnectedAccount: composio.verify,
}));

const dataDir = mkdtempSync(join(tmpdir(), "chvor-oauth-broker-security-"));
process.env.CHVOR_DATA_DIR = dataDir;

let oauth: (typeof import("../oauth.ts"))["default"];
let credentials: typeof import("../../db/credential-store.ts");
let setupStore: typeof import("../../db/integration-setup-store.ts");
let getDb: typeof import("../../db/database.ts").getDb;
let closeDb: typeof import("../../db/database.ts").closeDb;

async function request(path: string, body?: unknown): Promise<Response> {
  return oauth.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function initiateBroker(accountId: string) {
  credentials.createCredential("Composio", "composio", { apiKey: "composio-secret" });
  composio.initiate.mockResolvedValue({
    redirectUrl: "https://broker.example.test/connect",
    connectedAccountId: accountId,
  });
  const response = await request("/initiate", { provider: "twitter" });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: {
      connectionId: string;
      flowId: string;
      callbackOrigin: string;
      method: string;
    };
  };
}

function callbackPath(accountId: string, flowId: string, status = "success"): string {
  return `/callback?status=${status}&connectedAccountId=${accountId}&flowId=${encodeURIComponent(flowId)}`;
}

function envelopeCount(flowId: string): number {
  const row = getDb()
    .prepare(
      `SELECT count(*) AS count FROM integration_setup_secret_envelopes
       WHERE flow_id = ? AND purpose = 'staged-oauth'`
    )
    .get(flowId) as { count: number };
  return row.count;
}

beforeAll(async () => {
  ({ default: oauth } = await import("../oauth.ts"));
  credentials = await import("../../db/credential-store.ts");
  setupStore = await import("../../db/integration-setup-store.ts");
  ({ getDb, closeDb } = await import("../../db/database.ts"));
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM integration_setup_flows").run();
  db.prepare("DELETE FROM credentials").run();
  composio.initiate.mockReset();
  composio.list.mockReset().mockResolvedValue([]);
  composio.disconnect.mockReset();
  composio.verify.mockReset().mockResolvedValue(false);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("durable broker OAuth callback security", () => {
  it("keeps the durable flow retryable after a transient broker initiation failure", async () => {
    credentials.createCredential("Composio", "composio", { apiKey: "composio-secret" });
    composio.initiate.mockRejectedValue(new Error("temporary broker outage"));

    const response = await request("/initiate", { provider: "twitter" });

    expect(response.status).toBe(502);
    expect(setupStore.listIntegrationSetupFlows()).toEqual([
      expect.objectContaining({ status: "awaiting-oauth", authStatus: "unknown" }),
    ]);
  });

  it("survives restart, remotely verifies the exact account, and consumes correlation once", async () => {
    const initiated = await initiateBroker("account_123");
    expect(initiated.data).toMatchObject({
      connectionId: "account_123",
      callbackOrigin: "http://localhost:9147",
      method: "composio",
    });
    const callbackUrl = new URL(composio.initiate.mock.calls[0][1] as string);
    expect(callbackUrl.searchParams.get("flowId")).toBe(initiated.data.flowId);
    const envelope = getDb()
      .prepare(
        `SELECT state_sha256, encrypted_payload FROM integration_setup_secret_envelopes
         WHERE flow_id = ? AND purpose = 'staged-oauth'`
      )
      .get(initiated.data.flowId) as { state_sha256: string; encrypted_payload: string };
    expect(envelope.state_sha256).toBe(createHash("sha256").update("account_123").digest("hex"));
    expect(envelope.encrypted_payload).not.toContain("account_123");

    closeDb();
    composio.verify.mockResolvedValue(true);
    const path = callbackPath("account_123", initiated.data.flowId);
    const html = await (await request(path)).text();
    expect(composio.verify).toHaveBeenCalledWith("account_123", "twitter");
    expect(html).toContain("Account Connected!");
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)?.status).toBe("completed");
    const replay = await (await request(path)).text();
    expect(replay).toContain('"errorCode":"oauth_broker_callback_invalid"');
    expect(composio.verify).toHaveBeenCalledTimes(1);
  });

  it("does not trust a forged success status or consume correlation before remote ACTIVE", async () => {
    const initiated = await initiateBroker("account_forged");
    const html = await (
      await request(callbackPath("account_forged", initiated.data.flowId, "active"))
    ).text();

    expect(html).toContain('"errorCode":"oauth_broker_account_unverified"');
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
      status: "awaiting-oauth",
      authStatus: "unknown",
    });
    expect(envelopeCount(initiated.data.flowId)).toBe(1);
  });

  it("preserves correlation when the exact account does not match the expected provider toolkit", async () => {
    const initiated = await initiateBroker("account_wrong_provider");
    composio.verify.mockImplementation(async (_accountId: string, toolkit: string) => {
      expect(toolkit).toBe("twitter");
      return false;
    });

    const html = await (
      await request(callbackPath("account_wrong_provider", initiated.data.flowId))
    ).text();
    expect(html).toContain('"errorCode":"oauth_broker_account_unverified"');
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)?.status).toBe(
      "awaiting-oauth"
    );
    expect(envelopeCount(initiated.data.flowId)).toBe(1);
  });

  it("preserves correlation after a transient verification error and completes on retry", async () => {
    const initiated = await initiateBroker("account_remote_retry");
    composio.verify
      .mockRejectedValueOnce(new Error("Composio unavailable"))
      .mockResolvedValueOnce(true);
    const path = callbackPath("account_remote_retry", initiated.data.flowId);

    const first = await (await request(path)).text();
    expect(first).toContain('"errorCode":"oauth_broker_account_unverified"');
    expect(envelopeCount(initiated.data.flowId)).toBe(1);
    const retried = await (await request(path)).text();
    expect(retried).toContain("Account Connected!");
    expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)?.status).toBe("completed");
    expect(envelopeCount(initiated.data.flowId)).toBe(0);
  });

  it("rolls back correlation consumption when durable completion fails and accepts a retry", async () => {
    const initiated = await initiateBroker("account_db_retry");
    composio.verify.mockResolvedValue(true);
    const path = callbackPath("account_db_retry", initiated.data.flowId);
    const db = getDb();
    db.exec(`
      CREATE TRIGGER fail_broker_flow_completion
      BEFORE UPDATE OF status ON integration_setup_flows
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'forced broker completion failure');
      END
    `);
    try {
      const failed = await (await request(path)).text();
      expect(failed).toContain('"errorCode":"oauth_flow_inactive"');
      expect(setupStore.getIntegrationSetupFlow(initiated.data.flowId)).toMatchObject({
        status: "awaiting-oauth",
        authStatus: "unknown",
      });
      expect(envelopeCount(initiated.data.flowId)).toBe(1);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_broker_flow_completion");
    }
    const retried = await (await request(path)).text();
    expect(retried).toContain("Account Connected!");
    expect(envelopeCount(initiated.data.flowId)).toBe(0);
  });
});
