import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature, verifyGenericSignature, verifyNotionSignature } from "../webhook-parsers.ts";

// ── GitHub signature verification ───────────────────────

describe("verifyGitHubSignature", () => {
  const secret = "test-webhook-secret";

  function sign(body: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }

  it("returns true for valid signature", () => {
    const body = '{"action":"opened"}';
    expect(verifyGitHubSignature(secret, body, sign(body))).toBe(true);
  });

  it("returns false for invalid signature", () => {
    expect(verifyGitHubSignature(secret, "body", "sha256=wrong")).toBe(false);
  });

  it("returns false for missing signature", () => {
    expect(verifyGitHubSignature(secret, "body", undefined)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const body = '{"test":true}';
    const sig = sign(body);
    expect(verifyGitHubSignature("wrong-secret", body, sig)).toBe(false);
  });
});

// ── Notion signature verification ───────────────────────

describe("verifyNotionSignature", () => {
  const secret = "notion-webhook-secret";

  function sign(body: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  it("returns true for valid signature", () => {
    const body = '{"type":"page_changed"}';
    expect(verifyNotionSignature(secret, body, sign(body))).toBe(true);
  });

  it("returns false for invalid signature", () => {
    expect(verifyNotionSignature(secret, "body", "deadbeef".repeat(8))).toBe(false);
  });

  it("returns false for missing signature", () => {
    expect(verifyNotionSignature(secret, "body", undefined)).toBe(false);
  });
});

// ── Generic signature verification ──────────────────────

describe("verifyGenericSignature", () => {
  const secret = "generic-secret";

  function sign(body: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }

  it("returns true for valid signature", () => {
    const body = "test payload";
    expect(verifyGenericSignature(secret, body, sign(body))).toBe(true);
  });

  it("returns false for invalid signature", () => {
    expect(verifyGenericSignature(secret, "body", "sha256=wrong")).toBe(false);
  });

  it("returns false for missing signature", () => {
    expect(verifyGenericSignature(secret, "body", undefined)).toBe(false);
  });
});
