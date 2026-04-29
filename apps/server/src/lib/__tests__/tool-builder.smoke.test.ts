import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolBagScope } from "@chvor/shared";

const tmp = mkdtempSync(join(tmpdir(), "chvor-tool-builder-"));
process.env.CHVOR_DATA_DIR = tmp;

let buildToolDefinitions: typeof import("../tool-builder.ts").buildToolDefinitions;
let invalidateToolCache: typeof import("../tool-builder.ts").invalidateToolCache;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;

beforeAll(async () => {
  ({ buildToolDefinitions, invalidateToolCache } = await import("../tool-builder.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
});

function reset() {
  for (const c of listCredentials()) deleteCredential(c.id);
  invalidateToolCache();
}

function synthTool(): Tool {
  return {
    kind: "tool",
    id: "github-lite",
    instructions: "",
    source: "user",
    path: "github-lite.md",
    builtIn: false,
    metadata: {
      name: "GitHub Lite",
      description: "test",
      version: "1.0.0",
      requires: { credentials: ["github"] },
      group: "git",
    },
    mcpServer: { transport: "synthesized" },
    synthesized: {
      source: "ai-draft",
      verified: true,
      generatedAt: new Date().toISOString(),
      credentialType: "github",
    },
    endpoints: [{ name: "repos", description: "List repos", method: "GET", path: "/repos" }],
  };
}

function params(defs: Record<string, unknown>): any {
  return (defs["github-lite__repos"] as any).parameters;
}

describe("tool-builder synthesized credentialId enum", () => {
  beforeEach(reset);

  it("does not add credentialId when only one credential exists", async () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_a" }, "work");
    const defs = await buildToolDefinitions([synthTool()]);
    expect(params(defs).shape.credentialId).toBeUndefined();
    expect(params(defs).safeParse({}).success).toBe(true);
  });

  it("adds an optional credentialId enum with names and usage context when ambiguous", async () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" }, "work");
    const personal = createCredential("Personal GitHub", "github", { apiKey: "ghp_b" }, "personal");
    const defs = await buildToolDefinitions([synthTool()]);
    const schema = params(defs);
    expect(schema.safeParse({ credentialId: work.id }).success).toBe(true);
    expect(schema.safeParse({ credentialId: personal.id }).success).toBe(true);
    expect(schema.safeParse({ credentialId: "invented" }).success).toBe(false);
    const desc = schema.shape.credentialId.description as string;
    expect(desc).toContain("Work GitHub");
    expect(desc).toContain("context: work");
  });

  it("skill allowedCredentialTypes can hide a synthesized tool of another credential type", async () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_a" }, "work");
    const scope: ToolBagScope = {
      groups: new Set<import("@chvor/shared").ToolGroupId | "*">(["*"]),
      requiredTools: new Set(),
      deniedTools: new Set(),
      isPermissive: true,
      contributingSkills: [],
      allowedCredentialTypes: new Set(["slack"]),
    };
    const defs = await buildToolDefinitions([synthTool()], scope);
    expect(defs["github-lite__repos"]).toBeUndefined();
  });
});
