import { describe, it, expect } from "vitest";
import { parseA2UIAction, sanitizeA2UIAction } from "@chvor/shared";

describe("parseA2UIAction", () => {
  it("accepts navigate:<panelId>", () => {
    expect(parseA2UIAction("navigate:skills")).toEqual({ kind: "navigate", panelId: "skills" });
    expect(parseA2UIAction("navigate:Settings_Panel-2")).toEqual({
      kind: "navigate",
      panelId: "Settings_Panel-2",
    });
  });

  it("accepts emit:<eventName>", () => {
    expect(parseA2UIAction("emit:user.refresh")).toEqual({
      kind: "emit",
      eventName: "user.refresh",
    });
  });

  it("accepts emit with URL-encoded JSON payload", () => {
    const encoded = encodeURIComponent(JSON.stringify({ id: 42 }));
    expect(parseA2UIAction(`emit:do.thing?${encoded}`)).toEqual({
      kind: "emit",
      eventName: "do.thing",
      payload: { id: 42 },
    });
  });

  it("accepts noop", () => {
    expect(parseA2UIAction("noop")).toEqual({ kind: "noop" });
  });

  it("rejects raw URLs", () => {
    expect(parseA2UIAction("https://evil.example.com")).toBeNull();
    expect(parseA2UIAction("http://localhost:9147/api/skills")).toBeNull();
  });

  it("rejects javascript: and data:", () => {
    expect(parseA2UIAction("javascript:alert(1)")).toBeNull();
    expect(parseA2UIAction("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects unknown schemes", () => {
    expect(parseA2UIAction("nav:home")).toBeNull();
    expect(parseA2UIAction("foo:bar")).toBeNull();
  });

  it("rejects malformed panel/event ids", () => {
    expect(parseA2UIAction("navigate:")).toBeNull();
    expect(parseA2UIAction("navigate:has spaces")).toBeNull();
    expect(parseA2UIAction("emit:")).toBeNull();
    // Starts with non-letter
    expect(parseA2UIAction("navigate:1foo")).toBeNull();
  });

  it("rejects oversized emit payloads", () => {
    const big = "x".repeat(5_000);
    expect(parseA2UIAction(`emit:foo?${encodeURIComponent(big)}`)).toBeNull();
  });

  it("rejects malformed emit payloads", () => {
    expect(parseA2UIAction("emit:foo?not-json")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseA2UIAction(undefined)).toBeNull();
    expect(parseA2UIAction(null)).toBeNull();
    expect(parseA2UIAction(42)).toBeNull();
    expect(parseA2UIAction({ kind: "navigate" })).toBeNull();
  });
});

describe("sanitizeA2UIAction", () => {
  it("returns the original string when valid", () => {
    expect(sanitizeA2UIAction("navigate:skills")).toBe("navigate:skills");
    expect(sanitizeA2UIAction("noop")).toBe("noop");
  });

  it("collapses anything unsafe to noop", () => {
    expect(sanitizeA2UIAction("https://evil.example.com")).toBe("noop");
    expect(sanitizeA2UIAction("javascript:alert(1)")).toBe("noop");
    expect(sanitizeA2UIAction(undefined)).toBe("noop");
    expect(sanitizeA2UIAction(null)).toBe("noop");
  });
});
