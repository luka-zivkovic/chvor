import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before the singleton loads.
const tmp = mkdtempSync(join(tmpdir(), "chvor-credupdate-"));
process.env.CHVOR_DATA_DIR = tmp;

let createCredential: typeof import("../credential-store.ts").createCredential;
let updateCredential: typeof import("../credential-store.ts").updateCredential;
let getCredentialData: typeof import("../credential-store.ts").getCredentialData;
let getCredentialCiphertextVersion: typeof import("../credential-store.ts").getCredentialCiphertextVersion;
let getDb: typeof import("../database.ts").getDb;
let closeDb: typeof import("../database.ts").closeDb;

beforeAll(async () => {
  ({ createCredential, updateCredential, getCredentialData, getCredentialCiphertextVersion } =
    await import("../credential-store.ts"));
  ({ getDb, closeDb } = await import("../database.ts"));
});

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
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

describe("updateCredential — atomic read/merge/write", () => {
  it("rejects the merge when the exact ciphertext read is no longer current", () => {
    const credential = createCredential("oauth", "oauth", {
      accessToken: "at-old",
      refreshToken: "rt-old",
      clientSecret: "secret-old",
    });
    const rotated = createCredential("rotated", "oauth", {
      accessToken: "at-rotated",
      refreshToken: "rt-rotated",
      clientSecret: "secret-rotated",
    });
    const rotatedCiphertext = getCredentialCiphertextVersion(rotated.id);
    expect(rotatedCiphertext).not.toBeNull();

    let injectedChange = false;
    const patch = new Proxy(
      { clientSecret: "setup-new" },
      {
        ownKeys(target) {
          injectedChange = true;
          getDb()
            .prepare("UPDATE credentials SET encrypted_data = ? WHERE id = ?")
            .run(rotatedCiphertext, credential.id);
          return Reflect.ownKeys(target);
        },
      }
    );

    const result = updateCredential(credential.id, "must-not-win", patch);

    expect(injectedChange).toBe(true);
    expect(result).toBeNull();
    expect(getCredentialData(credential.id)).toMatchObject({
      cred: { name: "oauth" },
      data: {
        accessToken: "at-rotated",
        refreshToken: "rt-rotated",
        clientSecret: "secret-rotated",
      },
    });
  });

  it("holds an immediate write lock while merging credential data", () => {
    const credential = createCredential("oauth-lock", "oauth", {
      accessToken: "at-current",
      refreshToken: "rt-current",
      clientSecret: "secret-current",
    });
    const competing = createCredential("competing", "oauth", {
      accessToken: "at-competing",
      refreshToken: "rt-competing",
      clientSecret: "secret-competing",
    });
    const competingCiphertext = getCredentialCiphertextVersion(competing.id);
    expect(competingCiphertext).not.toBeNull();

    const competingDb = new Database(join(tmp, "chvor.db"));
    competingDb.pragma("busy_timeout = 0");
    let writeAttempted = false;
    let writeBlocked = false;
    const patch = new Proxy(
      { clientSecret: "secret-setup" },
      {
        ownKeys(target) {
          writeAttempted = true;
          try {
            competingDb
              .prepare("UPDATE credentials SET encrypted_data = ? WHERE id = ?")
              .run(competingCiphertext, credential.id);
          } catch (err) {
            if ((err as { code?: string }).code !== "SQLITE_BUSY") throw err;
            writeBlocked = true;
          }
          return Reflect.ownKeys(target);
        },
      }
    );

    const result = (() => {
      try {
        return updateCredential(credential.id, undefined, patch);
      } finally {
        competingDb.close();
      }
    })();

    expect(writeAttempted).toBe(true);
    expect(writeBlocked).toBe(true);
    expect(result).not.toBeNull();
    expect(getCredentialData(credential.id)?.data).toEqual({
      accessToken: "at-current",
      refreshToken: "rt-current",
      clientSecret: "secret-setup",
    });
  });
});
