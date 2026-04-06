import { describe, it, expect } from "vitest";
import { getContextWindow, getMaxTokens, isFallbackEligible } from "../llm-router.ts";

// ── getContextWindow ────────────────────────────────────

describe("getContextWindow", () => {
  it("returns known context window for Claude models", () => {
    const window = getContextWindow("claude-sonnet-4-6");
    expect(window).toBe(200000);
  });

  it("returns default for unknown model", () => {
    const window = getContextWindow("totally-unknown-model-xyz");
    expect(window).toBeGreaterThan(0);
    expect(window).toBe(getContextWindow("another-unknown")); // same default
  });
});

// ── getMaxTokens ────────────────────────────────────────

describe("getMaxTokens", () => {
  it("returns known max tokens for GPT models", () => {
    const max = getMaxTokens("gpt-4o");
    expect(max).toBeGreaterThan(0);
  });

  it("returns default for unknown model", () => {
    const max = getMaxTokens("unknown-model-abc");
    expect(max).toBeGreaterThan(0);
  });
});

// ── isFallbackEligible ──────────────────────────────────

describe("isFallbackEligible", () => {
  it("returns true for rate limit (429)", () => {
    expect(isFallbackEligible({ status: 429 })).toBe(true);
  });

  it("returns true for server error (500)", () => {
    expect(isFallbackEligible({ status: 500 })).toBe(true);
  });

  it("returns true for bad gateway (502)", () => {
    expect(isFallbackEligible({ status: 502 })).toBe(true);
  });

  it("returns true for service unavailable (503)", () => {
    expect(isFallbackEligible({ status: 503 })).toBe(true);
  });

  it("returns true for gateway timeout (504)", () => {
    expect(isFallbackEligible({ status: 504 })).toBe(true);
  });

  it("returns true for overloaded (529)", () => {
    expect(isFallbackEligible({ status: 529 })).toBe(true);
  });

  it("returns true for timeout (408)", () => {
    expect(isFallbackEligible({ status: 408 })).toBe(true);
  });

  it("returns false for auth errors (401)", () => {
    expect(isFallbackEligible({ status: 401 })).toBe(false);
  });

  it("returns false for forbidden (403)", () => {
    expect(isFallbackEligible({ status: 403 })).toBe(false);
  });

  it("returns false for bad request (400)", () => {
    expect(isFallbackEligible({ status: 400 })).toBe(false);
  });

  it("returns false for not found (404)", () => {
    expect(isFallbackEligible({ status: 404 })).toBe(false);
  });

  it("returns true for timeout error messages", () => {
    expect(isFallbackEligible(new Error("Connection timeout"))).toBe(true);
    expect(isFallbackEligible(new Error("ETIMEDOUT"))).toBe(true);
    expect(isFallbackEligible(new Error("ECONNREFUSED"))).toBe(true);
    expect(isFallbackEligible(new Error("ECONNRESET"))).toBe(true);
  });

  it("returns true for overload messages", () => {
    expect(isFallbackEligible(new Error("server overloaded"))).toBe(true);
    expect(isFallbackEligible(new Error("rate limit exceeded"))).toBe(true);
    expect(isFallbackEligible(new Error("too many requests"))).toBe(true);
  });

  it("returns true for network errors", () => {
    expect(isFallbackEligible(new Error("fetch failed"))).toBe(true);
    expect(isFallbackEligible(new Error("network error"))).toBe(true);
  });

  it("returns false for unknown errors", () => {
    expect(isFallbackEligible(new Error("something else"))).toBe(false);
    expect(isFallbackEligible("a string")).toBe(false);
  });

  it("extracts status from statusCode property", () => {
    expect(isFallbackEligible({ statusCode: 429 })).toBe(true);
    expect(isFallbackEligible({ statusCode: 401 })).toBe(false);
  });

  it("extracts status from nested data.status", () => {
    expect(isFallbackEligible({ data: { status: 503 } })).toBe(true);
  });
});
