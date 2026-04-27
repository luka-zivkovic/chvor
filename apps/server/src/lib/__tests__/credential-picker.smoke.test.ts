import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before anything else loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-pick-"));
process.env.CHVOR_DATA_DIR = tmp;

let pickCredential: typeof import("../credential-picker.ts").pickCredential;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;
let setSessionPin: typeof import("../../db/session-pin-store.ts").setSessionPin;
let clearAllSessionPins: typeof import("../../db/session-pin-store.ts").clearAllSessionPins;
let getSessionPin: typeof import("../../db/session-pin-store.ts").getSessionPin;

beforeAll(async () => {
  ({ pickCredential } = await import("../credential-picker.ts"));
  ({ createCredential, deleteCredential, listCredentials } = await import("../../db/credential-store.ts"));
  ({ setSessionPin, clearAllSessionPins, getSessionPin } = await import("../../db/session-pin-store.ts"));
});

function reset() {
  // Wipe creds + pins between tests so each spec is isolated.
  for (const c of listCredentials()) deleteCredential(c.id);
  clearAllSessionPins("sess-1");
  clearAllSessionPins("sess-2");
}

describe("credential-picker — empty state", () => {
  beforeEach(reset);

  it("returns null when no credentials exist", () => {
    expect(pickCredential("github")).toBeNull();
  });

  it("returns null when only other-type credentials exist", () => {
    createCredential("OpenAI Key", "openai", { apiKey: "sk-x" });
    expect(pickCredential("github")).toBeNull();
  });
});

describe("credential-picker — single match", () => {
  beforeEach(reset);

  it("uses the only candidate without checking pins", () => {
    const cred = createCredential("Personal GitHub", "github", { apiKey: "ghp_x" });
    const pick = pickCredential("github", { sessionId: "sess-1" });
    expect(pick).toBeTruthy();
    expect(pick!.credentialId).toBe(cred.id);
    expect(pick!.reason).toBe("single-match");
    expect(pick!.candidateCount).toBe(1);
  });
});

describe("credential-picker — tool-pinned", () => {
  beforeEach(reset);

  it("honours frontmatter pinned id over everything else", () => {
    const a = createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    const b = createCredential("Personal GitHub", "github", { apiKey: "ghp_b" });
    const pick = pickCredential("github", {
      sessionId: "sess-1",
      toolPinnedId: b.id,
      preferredUsageContext: ["work", "enterprise"],
    });
    expect(pick!.credentialId).toBe(b.id);
    expect(pick!.reason).toBe("tool-pinned");
    // a should still be alive for other tests' sanity
    expect(listCredentials().some((c) => c.id === a.id)).toBe(true);
  });

  it("falls through when pinned id no longer exists", () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    createCredential("Personal GitHub", "github", { apiKey: "ghp_b" });
    const pick = pickCredential("github", {
      sessionId: "sess-1",
      toolPinnedId: "this-id-does-not-exist",
    });
    // Falls through to context-match (none) → first-match-fallback
    expect(pick!.reason).toBe("first-match-fallback");
  });
});

describe("credential-picker — session pin", () => {
  beforeEach(reset);

  it("uses the session pin when one is set", () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" }, "work, enterprise");
    const personal = createCredential("Personal GitHub", "github", { apiKey: "ghp_b" }, "side projects");
    setSessionPin("sess-1", "github", work.id);
    const pick = pickCredential("github", { sessionId: "sess-1" });
    expect(pick!.credentialId).toBe(work.id);
    expect(pick!.reason).toBe("session-pin");
    // Different session uses fallback
    const otherSession = pickCredential("github", { sessionId: "sess-2" });
    expect(otherSession!.reason).toBe("first-match-fallback");
    void personal;
  });

  it("survives credential deletion by purging the pin", () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" });
    setSessionPin("sess-1", "github", work.id);
    expect(getSessionPin("sess-1", "github")).toBeTruthy();
    deleteCredential(work.id);
    expect(getSessionPin("sess-1", "github")).toBeNull();
  });
});

describe("credential-picker — context-match", () => {
  beforeEach(reset);

  it("breaks ties using usage_context overlap", () => {
    const work = createCredential("Work GitHub", "github", { apiKey: "ghp_a" }, "work, enterprise repos");
    const personal = createCredential("Personal GitHub", "github", { apiKey: "ghp_b" }, "side projects, open source");
    const pick = pickCredential("github", {
      sessionId: "sess-1",
      preferredUsageContext: ["work", "enterprise"],
    });
    expect(pick!.credentialId).toBe(work.id);
    expect(pick!.reason).toBe("context-match");
    void personal;
  });

  it("does NOT pick by context when scores tie — falls through to first-match", () => {
    createCredential("A GitHub", "github", { apiKey: "ghp_a" }, "work");
    createCredential("B GitHub", "github", { apiKey: "ghp_b" }, "work");
    const pick = pickCredential("github", { preferredUsageContext: ["work"] });
    expect(pick!.reason).toBe("first-match-fallback");
  });
});

describe("credential-picker — first-match-fallback", () => {
  beforeEach(reset);

  it("picks alphabetically-first credential when no other tier wins", () => {
    createCredential("Zeta GitHub", "github", { apiKey: "ghp_z" });
    createCredential("Alpha GitHub", "github", { apiKey: "ghp_a" });
    const pick = pickCredential("github");
    expect(pick!.reason).toBe("first-match-fallback");
    const summary = listCredentials().find((c) => c.id === pick!.credentialId);
    expect(summary?.name).toBe("Alpha GitHub");
  });
});
