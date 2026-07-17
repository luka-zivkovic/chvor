import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "chvor-auth-credential-routes-"));
process.env.CHVOR_DATA_DIR = dataDir;

let app: Hono;
let genericKey = "";
let readKey = "";
let writeKey = "";
let closeDb: typeof import("../../db/database.ts").closeDb;
let readCalls = 0;
let mutationCalls = 0;

function auth(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  const [{ chvorAuth }, authStore, apiKeyStore, database] = await Promise.all([
    import("../auth.ts"),
    import("../../db/auth-store.ts"),
    import("../../db/api-key-store.ts"),
    import("../../db/database.ts"),
  ]);
  closeDb = database.closeDb;
  authStore.enableAuth();
  genericKey = apiKeyStore.generateApiKey("generic", undefined, "api:read,api:write").key;
  readKey = apiKeyStore.generateApiKey("credential reader", undefined, "credential:read").key;
  writeKey = apiKeyStore.generateApiKey("credential writer", undefined, "credential:write").key;

  app = new Hono();
  app.use("/api/*", chvorAuth);
  app.get("/api/integration-setup/:id", (c) => {
    readCalls += 1;
    return c.json({ ok: true });
  });
  app.post("/api/integration-setup", (c) => {
    mutationCalls += 1;
    return c.json({ ok: true }, 201);
  });
  app.get("/api/oauth/connections", (c) => {
    readCalls += 1;
    return c.json({ ok: true });
  });
  app.post("/api/oauth/initiate", (c) => {
    mutationCalls += 1;
    return c.json({ ok: true }, 201);
  });
});

afterAll(() => {
  closeDb?.();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("credential-domain route authorization", () => {
  it("rejects generic API keys before setup and OAuth handlers can mutate state", async () => {
    const readsBefore = readCalls;
    const mutationsBefore = mutationCalls;

    expect(
      (await app.request("/api/integration-setup/flow-1", { headers: auth(genericKey) })).status
    ).toBe(403);
    expect(
      (
        await app.request("/api/integration-setup", {
          method: "POST",
          headers: auth(genericKey),
        })
      ).status
    ).toBe(403);
    expect(
      (await app.request("/api/oauth/connections", { headers: auth(genericKey) })).status
    ).toBe(403);
    expect(
      (
        await app.request("/api/oauth/initiate", {
          method: "POST",
          headers: auth(genericKey),
        })
      ).status
    ).toBe(403);

    expect(readCalls).toBe(readsBefore);
    expect(mutationCalls).toBe(mutationsBefore);
  });

  it("enforces read and write credential scopes independently", async () => {
    expect(
      (await app.request("/api/integration-setup/flow-1", { headers: auth(readKey) })).status
    ).toBe(200);
    expect((await app.request("/api/oauth/connections", { headers: auth(readKey) })).status).toBe(
      200
    );
    expect(
      (
        await app.request("/api/integration-setup", {
          method: "POST",
          headers: auth(readKey),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await app.request("/api/oauth/initiate", {
          method: "POST",
          headers: auth(writeKey),
        })
      ).status
    ).toBe(201);
    expect(
      (await app.request("/api/integration-setup/flow-1", { headers: auth(writeKey) })).status
    ).toBe(403);
  });
});
