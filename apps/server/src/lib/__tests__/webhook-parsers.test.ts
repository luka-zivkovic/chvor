import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

// Mock the DB layer so importing webhook-executor doesn't pull in better-sqlite3
vi.mock("../../db/webhook-store.ts", () => ({
  recordWebhookEvent: vi.fn(),
  countRecentWebhookEvents: vi.fn(() => 0),
}));
vi.mock("../../db/activity-store.ts", () => ({
  insertActivity: vi.fn(() => ({ id: "mock" })),
}));
vi.mock("../orchestrator.ts", () => ({
  executeConversation: vi.fn(),
}));
vi.mock("../error-logger.ts", () => ({
  logError: vi.fn(),
}));

import { verifyGitHubSignature, verifyGenericSignature, verifyNotionSignature, verifyBearerToken, parseWebhookPayload, renderTemplate } from "../webhook-parsers.ts";
import { matchesFilters } from "../webhook-executor.ts";
import type { ParsedWebhookEvent, WebhookFilter } from "@chvor/shared";

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

// ── Bearer token verification (Gmail Pub/Sub) ───────────

describe("verifyBearerToken", () => {
  const token = "my-push-endpoint-token";

  it("returns true for valid Bearer token", () => {
    expect(verifyBearerToken(token, `Bearer ${token}`)).toBe(true);
  });

  it("returns false for wrong token", () => {
    expect(verifyBearerToken(token, "Bearer wrong-token")).toBe(false);
  });

  it("returns false for missing header", () => {
    expect(verifyBearerToken(token, undefined)).toBe(false);
  });

  it("returns false for non-Bearer auth", () => {
    expect(verifyBearerToken(token, `Basic ${token}`)).toBe(false);
  });

  it("returns false for empty Bearer value", () => {
    expect(verifyBearerToken(token, "Bearer ")).toBe(false);
  });
});

// ── parseWebhookPayload ────────────────────────────────

describe("parseWebhookPayload", () => {
  it("parses GitHub pull_request event", () => {
    const headers = new Headers({ "x-github-event": "pull_request" });
    const body = {
      action: "opened",
      repository: { full_name: "org/repo" },
      sender: { login: "alice" },
      pull_request: { title: "Fix bug", number: 42, html_url: "https://github.com/org/repo/pull/42", head: { ref: "fix-branch" }, body: "Description" },
    };
    const result = parseWebhookPayload("github", headers, body);
    expect(result.eventType).toBe("pull_request.opened");
    expect(result.summary).toContain("PR #42");
    expect(result.summary).toContain("@alice");
    expect(result.details.branch).toBe("fix-branch");
    expect(result.details.repo).toBe("org/repo");
  });

  it("parses GitHub push event", () => {
    const headers = new Headers({ "x-github-event": "push" });
    const body = {
      repository: { full_name: "org/repo" },
      sender: { login: "bob" },
      ref: "refs/heads/main",
      commits: [{}, {}, {}],
    };
    const result = parseWebhookPayload("github", headers, body);
    expect(result.eventType).toBe("push");
    expect(result.details.branch).toBe("main");
    expect(result.details.commitCount).toBe(3);
  });

  it("parses GitHub event with missing fields gracefully", () => {
    const headers = new Headers({ "x-github-event": "star" });
    const body = {};
    const result = parseWebhookPayload("github", headers, body);
    expect(result.eventType).toBe("star");
    expect(result.summary).toContain("unknown");
  });

  it("parses Notion url_verification challenge", () => {
    const result = parseWebhookPayload("notion", new Headers(), {
      type: "url_verification",
      challenge: "abc123",
    });
    expect(result.eventType).toBe("url_verification");
    expect(result.details.challenge).toBe("abc123");
  });

  it("parses Notion page event with title extraction", () => {
    const result = parseWebhookPayload("notion", new Headers(), {
      type: "page.updated",
      data: {
        properties: {
          Name: { type: "title", title: [{ plain_text: "My Page" }] },
        },
      },
    });
    expect(result.eventType).toBe("page.updated");
    expect(result.details.title).toBe("My Page");
    expect(result.summary).toContain("My Page");
  });

  it("parses Gmail push notification", () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: "user@gmail.com", historyId: "12345" })).toString("base64");
    const result = parseWebhookPayload("gmail", new Headers(), {
      message: { data },
    });
    expect(result.eventType).toBe("gmail.notification");
    expect(result.details.emailAddress).toBe("user@gmail.com");
    expect(result.details.historyId).toBe("12345");
  });

  it("handles Gmail with malformed base64 data", () => {
    const result = parseWebhookPayload("gmail", new Headers(), {
      message: { data: "not-valid-json-base64" },
    });
    expect(result.eventType).toBe("gmail.notification");
    expect(result.details.rawData).toBeDefined();
  });

  it("parses generic payload using x-event-type header", () => {
    const headers = new Headers({ "x-event-type": "order.created" });
    const result = parseWebhookPayload("generic", headers, { orderId: 1 });
    expect(result.eventType).toBe("order.created");
  });

  it("parses generic payload using body event field", () => {
    const result = parseWebhookPayload("generic", new Headers(), { event: "user.signup", name: "Alice" });
    expect(result.eventType).toBe("user.signup");
  });

  it("returns parse_error for non-object body on typed sources", () => {
    const result = parseWebhookPayload("github", new Headers(), "not an object");
    expect(result.eventType).toBe("parse_error");
    expect(result.summary).toContain("Expected JSON object");
  });

  it("handles generic source with string body", () => {
    const result = parseWebhookPayload("generic", new Headers(), "plain text body");
    expect(result.eventType).toBe("unknown");
    expect(result.summary).toBe("plain text body");
  });
});

// ── renderTemplate ─────────────────────────────────────

describe("renderTemplate", () => {
  const parsed: ParsedWebhookEvent = {
    eventType: "push",
    summary: "3 commits pushed to main",
    details: { branch: "main", commitCount: 3, repo: "org/repo" },
    rawPayload: { ref: "refs/heads/main" },
  };

  it("replaces event.type and event.summary", () => {
    const result = renderTemplate("Type: {{event.type}}, Summary: {{event.summary}}", parsed);
    expect(result).toContain("[WEBHOOK_DATA]push[/WEBHOOK_DATA]");
    expect(result).toContain("[WEBHOOK_DATA]3 commits pushed to main[/WEBHOOK_DATA]");
  });

  it("replaces event.details.* keys", () => {
    const result = renderTemplate("Branch: {{event.details.branch}}", parsed);
    expect(result).toContain("[WEBHOOK_DATA]main[/WEBHOOK_DATA]");
  });

  it("replaces {{payload}} with truncated JSON", () => {
    const result = renderTemplate("Payload: {{payload}}", parsed);
    expect(result).toContain("[WEBHOOK_DATA]");
    expect(result).toContain("refs/heads/main");
  });

  it("leaves unrecognized template variables untouched", () => {
    const result = renderTemplate("{{unknown.var}} stays", parsed);
    expect(result).toContain("{{unknown.var}} stays");
  });

  it("includes prompt injection warning", () => {
    const result = renderTemplate("test", parsed);
    expect(result).toContain("untrusted data from an external webhook payload");
  });

  it("handles empty template", () => {
    const result = renderTemplate("", parsed);
    expect(result).toContain("untrusted data");
  });

  it("serializes non-string detail values as JSON", () => {
    const result = renderTemplate("Count: {{event.details.commitCount}}", parsed);
    expect(result).toContain("[WEBHOOK_DATA]3[/WEBHOOK_DATA]");
  });
});

// ── matchesFilters ─────────────────────────────────────

describe("matchesFilters", () => {
  const baseParsed: ParsedWebhookEvent = {
    eventType: "pull_request.opened",
    summary: "PR opened",
    details: { branch: "main" },
    rawPayload: {},
  };

  it("returns true when no filters", () => {
    expect(matchesFilters(baseParsed, null)).toBe(true);
  });

  it("returns true when empty filter object", () => {
    expect(matchesFilters(baseParsed, {})).toBe(true);
  });

  it("matches exact event type", () => {
    expect(matchesFilters(baseParsed, { eventTypes: ["pull_request.opened"] })).toBe(true);
  });

  it("matches event type prefix", () => {
    expect(matchesFilters(baseParsed, { eventTypes: ["pull_request"] })).toBe(true);
  });

  it("rejects non-matching event type", () => {
    expect(matchesFilters(baseParsed, { eventTypes: ["push"] })).toBe(false);
  });

  it("matches branch filter", () => {
    expect(matchesFilters(baseParsed, { branches: ["main"] })).toBe(true);
  });

  it("rejects non-matching branch", () => {
    expect(matchesFilters(baseParsed, { branches: ["develop"] })).toBe(false);
  });

  it("rejects when branch filter set but event has no branch", () => {
    const noBranch = { ...baseParsed, details: {} };
    expect(matchesFilters(noBranch, { branches: ["main"] })).toBe(false);
  });

  it("combines event type and branch filters (both must match)", () => {
    expect(matchesFilters(baseParsed, { eventTypes: ["pull_request"], branches: ["main"] })).toBe(true);
    expect(matchesFilters(baseParsed, { eventTypes: ["pull_request"], branches: ["develop"] })).toBe(false);
    expect(matchesFilters(baseParsed, { eventTypes: ["push"], branches: ["main"] })).toBe(false);
  });

  it("handles empty eventTypes array as no filter", () => {
    expect(matchesFilters(baseParsed, { eventTypes: [] })).toBe(true);
  });

  it("handles empty branches array as no filter", () => {
    expect(matchesFilters(baseParsed, { branches: [] })).toBe(true);
  });
});
