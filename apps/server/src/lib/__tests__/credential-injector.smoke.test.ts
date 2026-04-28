import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before anything loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-credinject-"));
process.env.CHVOR_DATA_DIR = tmp;

let injectPlaceholders: typeof import("../credential-injector.ts").injectPlaceholders;
let hasCredentialPlaceholder: typeof import("../credential-injector.ts").hasCredentialPlaceholder;
let extractSecretValues: typeof import("../credential-injector.ts").extractSecretValues;
let withSecretSeal: typeof import("../credential-injector.ts").withSecretSeal;
let withSecretSealSync: typeof import("../credential-injector.ts").withSecretSealSync;
let redactKnownSecrets: typeof import("../credential-injector.ts").redactKnownSecrets;
let redactKnownSecretsInString: typeof import("../credential-injector.ts").redactKnownSecretsInString;
let hasActiveSecrets: typeof import("../credential-injector.ts").hasActiveSecrets;
let addSecretsToSeal: typeof import("../credential-injector.ts").addSecretsToSeal;
let parseCredRef: typeof import("../credential-injector.ts").parseCredRef;
let PLACEHOLDER_RE: typeof import("../credential-injector.ts").PLACEHOLDER_RE;

beforeAll(async () => {
  ({
    injectPlaceholders,
    hasCredentialPlaceholder,
    extractSecretValues,
    withSecretSeal,
    withSecretSealSync,
    redactKnownSecrets,
    redactKnownSecretsInString,
    hasActiveSecrets,
    addSecretsToSeal,
    parseCredRef,
    PLACEHOLDER_RE,
  } = await import("../credential-injector.ts"));
});

describe("credential-injector — placeholder injection", () => {
  it("hasCredentialPlaceholder is cheap and exact", () => {
    expect(hasCredentialPlaceholder("plain text")).toBe(false);
    expect(hasCredentialPlaceholder("hello {{credentials.github}}")).toBe(true);
    expect(hasCredentialPlaceholder("{{credentials.x.y}}")).toBe(true);
    // Don't false-positive on partial matches — the prefix is the contract.
    expect(hasCredentialPlaceholder("{{credenti")).toBe(false);
  });

  it("substitutes a single placeholder using byType map", () => {
    const byType = new Map<string, Record<string, string>>([
      ["github", { token: "ghp_test_abc123" }],
    ]);
    expect(injectPlaceholders("Authorization: Bearer {{credentials.github}}", { byType })).toBe(
      "Authorization: Bearer ghp_test_abc123",
    );
  });

  it("supports field selection via dot notation", () => {
    const byType = new Map<string, Record<string, string>>([
      ["n8n", { apiUrl: "https://x.io", apiKey: "k" }],
    ]);
    expect(injectPlaceholders("URL={{credentials.n8n.apiUrl}}", { byType })).toBe(
      "URL=https://x.io",
    );
  });

  it("falls back to apiKey/token/key/first-value when no field is named", () => {
    const byType = new Map<string, Record<string, string>>([
      ["a", { apiKey: "ak" }],
      ["b", { token: "tk" }],
      ["c", { key: "kk" }],
      ["d", { somethingElse: "se_value" }],
    ]);
    expect(injectPlaceholders("{{credentials.a}}", { byType })).toBe("ak");
    expect(injectPlaceholders("{{credentials.b}}", { byType })).toBe("tk");
    expect(injectPlaceholders("{{credentials.c}}", { byType })).toBe("kk");
    expect(injectPlaceholders("{{credentials.d}}", { byType })).toBe("se_value");
  });

  it("URL-encodes when urlEncode is true", () => {
    const byType = new Map<string, Record<string, string>>([
      ["x", { token: "a/b c" }],
    ]);
    expect(injectPlaceholders("?k={{credentials.x}}", { byType, urlEncode: true })).toBe(
      "?k=a%2Fb%20c",
    );
  });

  it("throws when a placeholder has no resolved data", () => {
    expect(() => injectPlaceholders("{{credentials.missing}}", { byType: new Map() })).toThrow(
      /no credential data for type "missing"/,
    );
  });

  it("throws when the resolved data has no usable value for the field", () => {
    const byType = new Map<string, Record<string, string>>([["x", { token: "" }]]);
    expect(() => injectPlaceholders("{{credentials.x.token}}", { byType })).toThrow(
      /has no usable value/,
    );
  });

  it("returns the input unchanged when there are no placeholders", () => {
    expect(injectPlaceholders("hello world", { byType: new Map() })).toBe("hello world");
  });
});

describe("credential-injector — extractSecretValues", () => {
  it("includes credential-like fields and excludes connection metadata", () => {
    const out = extractSecretValues({
      apiKey: "ghp_thisIsAValidToken",
      token: "another_token_value",
      apiUrl: "https://example.com",   // excluded
      username: "alice@example.com",   // excluded
      region: "us-east-1",             // excluded
    });
    expect(out).toContain("ghp_thisIsAValidToken");
    expect(out).toContain("another_token_value");
    expect(out).not.toContain("https://example.com");
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("us-east-1");
  });

  it("drops short values to avoid scrubbing common substrings", () => {
    const out = extractSecretValues({ apiKey: "abc" }); // 3 chars — too short
    expect(out).toEqual([]);
  });

  it("excludes provider connection-metadata fields from the seal", () => {
    // Real field names from provider-registry.ts (Matrix/Obsidian/GitLab/OAuth apps)
    // — these are not secrets and shouldn't be scrubbed out of unrelated audit text.
    const out = extractSecretValues({
      homeserverUrl: "https://matrix.example.org",
      userId: "@alice:matrix.example.org",
      vaultPath: "/Users/alice/Documents/Obsidian Vault",
      instanceUrl: "https://gitlab.example.com",
      clientId: "1234567890-abc.apps.googleusercontent.com",
      // These ARE secrets and must still be sealed.
      accessToken: "mxa_abcdefghijklmnop",
      clientSecret: "GOCSPX-supersecret_value",
    });
    expect(out).toContain("mxa_abcdefghijklmnop");
    expect(out).toContain("GOCSPX-supersecret_value");
    expect(out).not.toContain("https://matrix.example.org");
    expect(out).not.toContain("@alice:matrix.example.org");
    expect(out).not.toContain("/Users/alice/Documents/Obsidian Vault");
    expect(out).not.toContain("https://gitlab.example.com");
    expect(out).not.toContain("1234567890-abc.apps.googleusercontent.com");
  });
});

describe("credential-injector — seal + redact", () => {
  it("redactKnownSecrets is a noop when no seal is open", () => {
    expect(hasActiveSecrets()).toBe(false);
    expect(redactKnownSecretsInString("plain text with ghp_secret_value")).toBe(
      "plain text with ghp_secret_value",
    );
  });

  it("withSecretSealSync registers + clears + scrubs strings during the seal", () => {
    const SECRET = "ghp_unique_secret_xyz";
    const before = redactKnownSecretsInString(`auth=${SECRET}`);
    expect(before).toBe(`auth=${SECRET}`);

    const inside = withSecretSealSync([SECRET], () => {
      expect(hasActiveSecrets()).toBe(true);
      return redactKnownSecretsInString(`auth=${SECRET}`);
    });
    expect(inside).toBe("auth=«credential»");

    expect(hasActiveSecrets()).toBe(false);
  });

  it("withSecretSeal restores state even when fn throws", async () => {
    const SECRET = "leak_value_that_should_clear";
    await expect(
      withSecretSeal([SECRET], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(hasActiveSecrets()).toBe(false);
  });

  it("nested seals ref-count and only release when fully closed", async () => {
    const A = "secret_value_aaaaaa";
    await withSecretSeal([A], async () => {
      expect(hasActiveSecrets()).toBe(true);
      await withSecretSeal([A], async () => {
        expect(hasActiveSecrets()).toBe(true);
      });
      // Inner closed but outer still active.
      expect(hasActiveSecrets()).toBe(true);
    });
    expect(hasActiveSecrets()).toBe(false);
  });

  it("redactKnownSecrets walks objects + arrays + nested structures", () => {
    const SECRET = "redact_me_xyz_123";
    withSecretSealSync([SECRET], () => {
      const out = redactKnownSecrets({
        a: SECRET,
        b: [SECRET, { c: SECRET, d: "untouched" }],
        e: 42,
        f: null,
      });
      expect(out).toEqual({
        a: "«credential»",
        b: ["«credential»", { c: "«credential»", d: "untouched" }],
        e: 42,
        f: null,
      });
    });
  });

  it("does not mutate the original input", () => {
    const SECRET = "original_secret_value";
    const input = { token: SECRET };
    withSecretSealSync([SECRET], () => {
      redactKnownSecrets(input);
    });
    expect(input.token).toBe(SECRET);
  });

  it("ignores empty + below-threshold seal entries", () => {
    withSecretSealSync(["", "abc", "long_enough_secret"], () => {
      // Only the long one should redact.
      expect(redactKnownSecretsInString("a=abc, b=long_enough_secret")).toBe(
        "a=abc, b=«credential»",
      );
    });
  });
});

describe("credential-injector — addSecretsToSeal (OAuth refresh path)", () => {
  it("registers additional secrets on top of an open seal and releases on call", () => {
    const ORIGINAL = "original_access_token_xxxxx";
    const REFRESHED = "refreshed_access_token_yyyyy";
    withSecretSealSync([ORIGINAL], () => {
      // Both original sealed; refreshed not yet.
      expect(redactKnownSecretsInString(`a=${ORIGINAL} b=${REFRESHED}`)).toBe(
        `a=«credential» b=${REFRESHED}`,
      );
      const release = addSecretsToSeal([REFRESHED]);
      try {
        // Both sealed during retry pipeline.
        expect(redactKnownSecretsInString(`a=${ORIGINAL} b=${REFRESHED}`)).toBe(
          "a=«credential» b=«credential»",
        );
      } finally {
        release();
      }
      // Refreshed released; outer seal still active for original.
      expect(redactKnownSecretsInString(`a=${ORIGINAL} b=${REFRESHED}`)).toBe(
        `a=«credential» b=${REFRESHED}`,
      );
    });
    expect(hasActiveSecrets()).toBe(false);
  });

  it("ref-counts when refreshed value overlaps with original", () => {
    const SHARED = "shared_long_secret_value";
    withSecretSealSync([SHARED], () => {
      const release = addSecretsToSeal([SHARED]);
      release();
      // Outer seal still keeps SHARED active even though add+release ran.
      expect(redactKnownSecretsInString(`x=${SHARED}`)).toBe("x=«credential»");
    });
    expect(hasActiveSecrets()).toBe(false);
  });

  it("skips empty + below-threshold values like withSecretSeal does", () => {
    const release = addSecretsToSeal(["", "abc", "long_enough_value"]);
    try {
      expect(redactKnownSecretsInString("a=abc b=long_enough_value")).toBe(
        "a=abc b=«credential»",
      );
    } finally {
      release();
    }
    expect(hasActiveSecrets()).toBe(false);
  });
});

describe("credential-injector — exported regex + parser", () => {
  it("PLACEHOLDER_RE matches the documented syntax", () => {
    // Regex has /g — reset lastIndex to test repeatedly.
    PLACEHOLDER_RE.lastIndex = 0;
    expect("hello {{credentials.github}}".match(PLACEHOLDER_RE)?.[0]).toBe(
      "{{credentials.github}}",
    );
    PLACEHOLDER_RE.lastIndex = 0;
    expect("a={{credentials.n8n.apiUrl}}".match(PLACEHOLDER_RE)?.[0]).toBe(
      "{{credentials.n8n.apiUrl}}",
    );
    PLACEHOLDER_RE.lastIndex = 0;
    expect("plain text".match(PLACEHOLDER_RE)).toBeNull();
  });

  it("parseCredRef splits on the first dot only", () => {
    expect(parseCredRef("github")).toEqual({ type: "github" });
    expect(parseCredRef("n8n.apiUrl")).toEqual({ type: "n8n", field: "apiUrl" });
    // Multi-dot is preserved in `field` (first dot is the separator).
    expect(parseCredRef("a.b.c")).toEqual({ type: "a", field: "b.c" });
  });
});
