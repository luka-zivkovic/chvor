import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthesizedEndpointParam, Tool } from "@chvor/shared";

const tmp = mkdtempSync(join(tmpdir(), "chvor-synth-caller-"));
process.env.CHVOR_DATA_DIR = tmp;

let callSynthesizedEndpoint: typeof import("../synthesized-caller.ts").callSynthesizedEndpoint;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;
let listPendingCredentialChoices: typeof import("../credential-choice.ts").listPendingCredentialChoices;
let resolveCredentialChoice: typeof import("../credential-choice.ts").resolveCredentialChoice;
let getSessionPin: typeof import("../../db/session-pin-store.ts").getSessionPin;
let clearAllSessionPins: typeof import("../../db/session-pin-store.ts").clearAllSessionPins;
let setWSInstance: typeof import("../../gateway/ws-instance.ts").setWSInstance;

beforeAll(async () => {
  ({ callSynthesizedEndpoint } = await import("../synthesized-caller.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
  ({ listPendingCredentialChoices, resolveCredentialChoice } =
    await import("../credential-choice.ts"));
  ({ getSessionPin, clearAllSessionPins } = await import("../../db/session-pin-store.ts"));
  ({ setWSInstance } = await import("../../gateway/ws-instance.ts"));
  setWSInstance({
    sendTo: () => true,
    getClientsBySessionId: () => ["ws-1"],
    broadcastToSession: () => undefined,
  } as never);
});

afterAll(() => {
  setWSInstance(null as never);
});

function reset() {
  for (const c of listCredentials()) deleteCredential(c.id);
  clearAllSessionPins("sess-choice");
  clearAllSessionPins("sess-pin");
}

async function waitForChoice(sessionId: string) {
  for (let i = 0; i < 50; i++) {
    const pending = listPendingCredentialChoices().filter((p) => p.sessionId === sessionId);
    if (pending.length > 0) return pending[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  return listPendingCredentialChoices().find((p) => p.sessionId === sessionId) ?? null;
}

function synthTool(pathParams: SynthesizedEndpointParam[] = []): Tool {
  return {
    kind: "tool",
    id: "github-lite",
    instructions: "",
    source: "user",
    path: "github-lite.md",
    builtIn: false,
    metadata: { name: "GitHub Lite", description: "test", version: "1.0.0", group: "git" },
    mcpServer: { transport: "synthesized" },
    synthesized: {
      source: "ai-draft",
      verified: true,
      generatedAt: new Date().toISOString(),
      credentialType: "github",
    },
    endpoints: [
      {
        name: "repos",
        description: "List repos",
        method: "GET",
        path: "/repos/{credentialId}",
        pathParams,
      },
    ],
  };
}

describe("synthesized-caller credentialId meta-arg", () => {
  beforeEach(reset);

  it("rejects an invented meta credentialId before picking", async () => {
    createCredential("GitHub", "github", { apiKey: "ghp_a" });
    const result = await callSynthesizedEndpoint(synthTool(), "repos", {
      credentialId: "invented",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid credentialId");
  });

  it("passes valid llm-picked id to the picker and emits pickedBy", async () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    const personal = createCredential("Personal GitHub", "github", { apiKey: "ghp_b" });
    const seen: unknown[] = [];
    const result = await callSynthesizedEndpoint(
      synthTool(),
      "repos",
      { credentialId: personal.id },
      {
        onCredentialResolved: (info) => seen.push(info),
      }
    );
    expect(result.ok).toBe(false); // no connectionConfig in this fixture; test stops before network.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      credentialId: personal.id,
      reason: "llm-picked",
      pickedBy: "llm-picked",
    });
    void work;
  });

  it("does not treat credentialId as meta when endpoint declares a real credentialId param", async () => {
    createCredential("GitHub", "github", { apiKey: "ghp_a" });
    const tool = synthTool([{ name: "credentialId", type: "string", required: true }]);
    const result = await callSynthesizedEndpoint(tool, "repos", { credentialId: "real-param" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("invalid credentialId");
  });

  it("asks the user when credential fallback is ambiguous", async () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    const personal = createCredential("Personal GitHub", "github", { apiKey: "ghp_b" });
    const seen: unknown[] = [];
    const promise = callSynthesizedEndpoint(
      synthTool(),
      "repos",
      {},
      {
        sessionId: "sess-choice",
        originClientId: "ws-1",
        onCredentialResolved: (info) => seen.push(info),
      }
    );

    const pending = await waitForChoice("sess-choice");
    expect(pending).toBeTruthy();
    expect(pending!.candidateIds.sort()).toEqual([personal.id, work.id].sort());
    const resolved = resolveCredentialChoice(
      {
        requestId: pending!.requestId,
        action: "use-once",
        credentialId: personal.id,
      },
      "ws-1"
    );
    expect(resolved.ok).toBe(true);

    const result = await promise;
    expect(result.ok).toBe(false); // no connectionConfig in this fixture; test stops before network.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      credentialId: personal.id,
      reason: "user-picked",
      pickedBy: "user-picked",
    });
  });

  it("can pin a user-picked credential for the session", async () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    createCredential("Personal GitHub", "github", { apiKey: "ghp_b" });
    const promise = callSynthesizedEndpoint(
      synthTool(),
      "repos",
      {},
      {
        sessionId: "sess-pin",
        originClientId: "ws-1",
      }
    );

    const pending = await waitForChoice("sess-pin");
    expect(pending).toBeTruthy();
    const resolved = resolveCredentialChoice(
      {
        requestId: pending!.requestId,
        action: "pin-session",
        credentialId: work.id,
      },
      "ws-1"
    );
    expect(resolved.ok).toBe(true);

    await promise;
    expect(getSessionPin("sess-pin", "github")?.credentialId).toBe(work.id);
  });
});
