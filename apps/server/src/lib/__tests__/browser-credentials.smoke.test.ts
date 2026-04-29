import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-browser-cred-"));
process.env.CHVOR_DATA_DIR = tmp;

let expandBrowserCredentials: typeof import("../native-tools/browser.ts").expandBrowserCredentials;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;

beforeAll(async () => {
  ({ expandBrowserCredentials } = await import("../native-tools/browser.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
});

function reset() {
  for (const c of listCredentials()) deleteCredential(c.id);
}

describe("expandBrowserCredentials — skill scope", () => {
  beforeEach(reset);

  it("rejects placeholders for credential types outside allowedCredentialTypes", () => {
    createCredential("Slack", "slack", { token: "xoxb-secret-token" });
    expect(() =>
      expandBrowserCredentials("send {{credentials.slack}} to #x", "sess-1", {
        allowedCredentialTypes: ["github"],
      })
    ).toThrow(/not allowed by the active skill scope/);
  });

  it("rejects byRef placeholders for credentials whose type is outside the scope", () => {
    const slack = createCredential("Slack", "slack", { token: "xoxb-secret-token" });
    expect(() =>
      expandBrowserCredentials(`send {{credentials.${slack.id}}}`, "sess-1", {
        allowedCredentialTypes: ["github"],
      })
    ).toThrow(/not allowed by the active skill scope/);
  });

  it("expands placeholders that are inside the allowed scope", () => {
    createCredential("GitHub", "github", { apiKey: "ghp_secret_value" });
    const out = expandBrowserCredentials("Bearer {{credentials.github}}", "sess-1", {
      allowedCredentialTypes: ["github"],
    });
    expect(out.expanded).toBe("Bearer ghp_secret_value");
    expect(out.expandedTypes).toEqual(["github"]);
    expect(out.secretsToSeal).toContain("ghp_secret_value");
  });
});

describe("expandBrowserCredentials — id/type collision", () => {
  beforeEach(reset);

  it("does not bypass type picker when credential id is not UUID-shaped", () => {
    // Two credentials of the same type so the picker has to pick one.
    createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work");
    const personal = createCredential(
      "Personal GitHub",
      "github",
      { apiKey: "ghp_personal" },
      "personal"
    );
    // A non-UUID ref must NOT short-circuit to a direct id lookup. With
    // allowedCredentialTypes restricting to "github" the picker still runs
    // and the ref is treated as a type literal.
    const out = expandBrowserCredentials("{{credentials.github}}", "sess-1", {
      allowedCredentialTypes: ["github"],
    });
    // Picker resolves to alphabetically-first when no other tier wins —
    // either "Personal GitHub" or "Work GitHub". Both are valid; the key
    // assertion is the call succeeded through the picker, not via id-match.
    expect(["ghp_personal", "ghp_work"]).toContain(out.expanded);
    void personal;
  });
});
