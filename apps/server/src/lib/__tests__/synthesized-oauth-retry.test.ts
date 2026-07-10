import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionConfig, Tool } from "@chvor/shared";

const tmp = mkdtempSync(join(tmpdir(), "chvor-synth-oauth-"));
process.env.CHVOR_DATA_DIR = tmp;

// Mock the network layer so we drive the 401 → refresh → retry path without
// real sockets or DNS. fetch() (used by the OAuth refresh) is mocked per-test.
const h = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  pinned: vi.fn(),
}));
vi.mock("../synthesized/network.ts", () => ({
  resolveSafeSynthesizedTarget: h.resolveTarget,
  pinnedHttpsRequest: h.pinned,
  assertSafeSynthesizedUrl: vi.fn(),
}));

let callSynthesizedEndpoint: typeof import("../synthesized-caller.ts").callSynthesizedEndpoint;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let updateConnectionConfig: typeof import("../../db/credential-store.ts").updateConnectionConfig;
let getCredentialData: typeof import("../../db/credential-store.ts").getCredentialData;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;

beforeAll(async () => {
  ({ callSynthesizedEndpoint } = await import("../synthesized-caller.ts"));
  ({ createCredential, updateConnectionConfig, getCredentialData, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
});

const connection: ConnectionConfig = {
  auth: { scheme: "bearer" },
  baseUrl: "https://api.demo.test",
  source: "user-provided",
  confidence: "high",
};

function oauthTool(): Tool {
  return {
    kind: "tool",
    id: "demo-api",
    instructions: "",
    source: "user",
    path: "demo-api.md",
    builtIn: false,
    metadata: { name: "Demo API", description: "test", version: "1.0.0", group: "git" },
    mcpServer: { transport: "synthesized" },
    synthesized: {
      source: "ai-draft",
      verified: true,
      generatedAt: new Date().toISOString(),
      credentialType: "demo-oauth",
    },
    endpoints: [{ name: "me", description: "who am i", method: "GET", path: "/v1/me" }],
  };
}

function pinnedResponse(status: number, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body), "utf-8");
  return {
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    headers: { "content-type": "application/json" },
    body: buf,
    truncated: false,
    size: buf.byteLength,
  };
}

describe("synthesized-caller — transparent OAuth refresh on 401", () => {
  beforeEach(() => {
    for (const c of listCredentials()) deleteCredential(c.id);
    vi.restoreAllMocks();
    h.resolveTarget.mockReset();
    h.pinned.mockReset();
    h.resolveTarget.mockResolvedValue({
      url: new URL("https://api.demo.test/v1/me"),
      resolvedIp: "93.184.216.34",
      hostname: "api.demo.test",
    });
  });

  it("refreshes the token, retries once, and persists the new access token", async () => {
    const cred = createCredential("Demo", "demo-oauth", {
      accessToken: "old-at",
      refreshToken: "old-rt",
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);

    // First live call → 401; retry after refresh → 200.
    h.pinned
      .mockResolvedValueOnce(pinnedResponse(401, { error: "token expired" }))
      .mockResolvedValueOnce(pinnedResponse(200, { ok: true }));

    // OAuth refresh exchange returns a fresh access token.
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
      text: async () => "",
    } as Response);

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result.ok).toBe(true);
    expect(h.pinned).toHaveBeenCalledTimes(2);

    // The retry must carry the refreshed access token, not the stale one.
    const retryHeaders = h.pinned.mock.calls[1][0].headers as Record<string, string>;
    expect(retryHeaders["Authorization"]).toBe("Bearer new-at");

    // And the new token must be persisted back to the credential store.
    expect(getCredentialData(cred.id)?.data.accessToken).toBe("new-at");
    expect(getCredentialData(cred.id)?.data.refreshToken).toBe("new-rt");
  });

  it("does not retry when there is no refresh token", async () => {
    const cred = createCredential("Demo", "demo-oauth", { accessToken: "old-at" });
    updateConnectionConfig(cred.id, connection);
    h.pinned.mockResolvedValueOnce(pinnedResponse(401, { error: "nope" }));

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});
    expect(result.ok).toBe(false);
    expect(h.pinned).toHaveBeenCalledTimes(1);
  });

  it("reports the retry response when refresh succeeds but the retry still fails", async () => {
    const cred = createCredential("Demo", "demo-oauth", {
      accessToken: "old-at",
      refreshToken: "old-rt",
      clientId: "cid",
      clientSecret: "csecret",
      tokenUrl: "https://token.demo.test/oauth/token",
      provider: "synthesized",
    });
    updateConnectionConfig(cred.id, connection);

    h.pinned
      .mockResolvedValueOnce(pinnedResponse(401, { error: "original token expired" }))
      .mockResolvedValueOnce(pinnedResponse(500, { error: "provider unavailable after refresh" }));

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "new-at", expires_in: 3600 }),
      text: async () => "",
    } as Response);

    const result = await callSynthesizedEndpoint(oauthTool(), "me", {});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the retried call to fail");
    expect(result.status).toBe(500);
    expect(result.error).toContain("provider unavailable after refresh");
    expect(result.error).not.toContain("original token expired");
    expect(h.pinned).toHaveBeenCalledTimes(2);
  });
});
