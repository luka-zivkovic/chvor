import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-credential-resolver-"));
process.env.CHVOR_DATA_DIR = tmp;

let resolveEnvPlaceholders: typeof import("../credential-resolver.ts").resolveEnvPlaceholders;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;
let setSessionPin: typeof import("../../db/session-pin-store.ts").setSessionPin;
let runWithTrajectoryCapture: typeof import("../orchestrator/trajectory-adapter.ts").runWithTrajectoryCapture;
let getTrajectory: typeof import("../../db/trajectory-store.ts").getTrajectory;
let getDb: typeof import("../../db/database.ts").getDb;

beforeAll(async () => {
  ({ resolveEnvPlaceholders } = await import("../credential-resolver.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
  ({ setSessionPin } = await import("../../db/session-pin-store.ts"));
  ({ runWithTrajectoryCapture } = await import("../orchestrator/trajectory-adapter.ts"));
  ({ getTrajectory } = await import("../../db/trajectory-store.ts"));
  ({ getDb } = await import("../../db/database.ts"));
});

function reset() {
  for (const c of listCredentials()) deleteCredential(c.id);
}

describe("credential-resolver MCP placeholder ambiguity", () => {
  beforeEach(reset);

  it("fails closed instead of silently resolving first-match fallback", () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work");
    createCredential("Personal GitHub", "github", { apiKey: "ghp_personal" }, "personal");

    expect(() =>
      resolveEnvPlaceholders({ GITHUB_TOKEN: "{{credentials.github}}" }, ["github"])
    ).toThrow(/multiple credentials of type "github"/);
  });

  it("resolves the pinned credential when a session pin selects a clear winner", () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work enterprise");
    createCredential("Personal GitHub", "github", { apiKey: "ghp_personal" }, "personal");
    setSessionPin("sess-env", "github", work.id);

    const resolved = resolveEnvPlaceholders(
      { GITHUB_TOKEN: "{{credentials.github}}" },
      ["github"],
      { sessionId: "sess-env" }
    );

    expect(resolved.GITHUB_TOKEN).toBe("ghp_work");
  });

  it("taints MCP credential values so echoed output never reaches raw trajectory rows", async () => {
    const secret = "opaque-mcp-secret-value";
    createCredential("MCP", "mcp-test", { apiKey: secret }, "mcp");

    await runWithTrajectoryCapture({
      messages: [
        {
          id: "mcp-message",
          role: "user",
          content: "run MCP",
          channelType: "web",
          timestamp: new Date().toISOString(),
        },
      ],
      emit: () => undefined,
      context: {
        id: "mcp-secret-trajectory",
        origin: { kind: "test" },
        actor: { type: "test", id: "test" },
      },
      execute: async () => {
        const resolved = resolveEnvPlaceholders(
          { MCP_TOKEN: "{{credentials.mcp-test}}" },
          ["mcp-test"]
        );
        return { echoed: resolved.MCP_TOKEN };
      },
    });

    expect(getTrajectory("mcp-secret-trajectory")?.output).toEqual({ echoed: "[REDACTED]" });
    const raw = JSON.stringify({
      trajectories: getDb().prepare("SELECT * FROM trajectories").all(),
      steps: getDb().prepare("SELECT * FROM trajectory_steps").all(),
    });
    expect(raw).not.toContain(secret);
  });
});
