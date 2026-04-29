import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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

beforeAll(async () => {
  ({ callSynthesizedEndpoint } = await import("../synthesized-caller.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
});

function reset() {
  for (const c of listCredentials()) deleteCredential(c.id);
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
});
