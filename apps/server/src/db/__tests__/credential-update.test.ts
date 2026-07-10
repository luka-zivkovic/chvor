import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before the singleton loads.
const tmp = mkdtempSync(join(tmpdir(), "chvor-credupdate-"));
process.env.CHVOR_DATA_DIR = tmp;

let createCredential: typeof import("../credential-store.ts").createCredential;
let updateCredential: typeof import("../credential-store.ts").updateCredential;
let getCredentialData: typeof import("../credential-store.ts").getCredentialData;

beforeAll(async () => {
  ({ createCredential, updateCredential, getCredentialData } = await import(
    "../credential-store.ts"
  ));
});

describe("updateCredential — field merge semantics", () => {
  it("keeps existing fields when a blank string is submitted (the old corruption bug)", () => {
    const c = createCredential("github", "github", {
      apiKey: "secret-key",
      username: "octocat",
    });
    // Simulate a form re-submit that only changes the name and leaves the
    // secret blank to mean "unchanged".
    updateCredential(c.id, "github-renamed", { apiKey: "", username: "" });

    const after = getCredentialData(c.id);
    expect(after?.data.apiKey).toBe("secret-key");
    expect(after?.data.username).toBe("octocat");
    expect(after?.cred.name).toBe("github-renamed");
  });

  it("overwrites a field with a non-empty value", () => {
    const c = createCredential("stripe", "stripe", { apiKey: "old" });
    updateCredential(c.id, undefined, { apiKey: "new" });
    expect(getCredentialData(c.id)?.data.apiKey).toBe("new");
  });

  it("deletes a field only when explicitly set to null", () => {
    const c = createCredential("svc", "svc", { apiKey: "k", legacy: "drop-me" });
    updateCredential(c.id, undefined, { legacy: null });
    const after = getCredentialData(c.id);
    expect(after?.data.legacy).toBeUndefined();
    expect(after?.data.apiKey).toBe("k");
  });

  it("handles a patch mixing delete / keep / set in one call", () => {
    const c = createCredential("svc", "svc", { a: "1", b: "2", c: "3" });
    updateCredential(c.id, undefined, { a: null, b: "", c: "new" });
    const after = getCredentialData(c.id);
    expect(after?.data.a).toBeUndefined(); // null → deleted
    expect(after?.data.b).toBe("2"); // "" → kept
    expect(after?.data.c).toBe("new"); // value → set
  });

  it("preserves an OAuth token blob across a partial update", () => {
    const c = createCredential("notion-oauth", "notion-oauth", {
      accessToken: "at-1",
      refreshToken: "rt-1",
      clientId: "cid",
      clientSecret: "csecret",
    });
    // A name-only edit must not drop any token field.
    updateCredential(c.id, "renamed", {});
    const after = getCredentialData(c.id);
    expect(after?.data).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
      clientId: "cid",
      clientSecret: "csecret",
    });
  });
});
