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

beforeAll(async () => {
  ({ resolveEnvPlaceholders } = await import("../credential-resolver.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
  ({ setSessionPin } = await import("../../db/session-pin-store.ts"));
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
});
