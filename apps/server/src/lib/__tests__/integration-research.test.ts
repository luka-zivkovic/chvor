import { describe, it, expect, vi } from "vitest";

// Mock llm-router so LLM calls are skipped (resolveRoleConfig returns error, never reached)
vi.mock("../llm-router.ts", () => ({
  resolveRoleConfig: () => {
    throw new Error("No LLM configured");
  },
  createModel: () => {
    throw new Error("No LLM configured");
  },
}));

import { researchIntegration } from "../integration-research.ts";

describe("researchIntegration", () => {
  it("returns a ProviderProposal with generic fallback fields", async () => {
    const result = await researchIntegration("some-random-api");
    expect(result).toBeDefined();
    expect(result.confidence).toBe("inferred");
    expect(result.fields.length).toBeGreaterThanOrEqual(1);
    const apiKeyField = result.fields.find((f) => f.key === "apiKey");
    expect(apiKeyField).toBeDefined();
  });

  it("normalizes slug: 'My Cool API' → credentialType 'my-cool-api'", async () => {
    const result = await researchIntegration("My Cool API");
    expect(result.credentialType).toBe("my-cool-api");
  });

  it("generic fallback always returns valid fields with apiKey and baseUrl", async () => {
    const result = await researchIntegration("totally-unknown-service-xyz");
    expect(result.name).toBeTruthy();
    expect(result.credentialType).toBeTruthy();
    expect(result.fields.length).toBeGreaterThanOrEqual(2);
    expect(result.fields.find((f) => f.key === "apiKey")).toBeDefined();
    expect(result.fields.find((f) => f.key === "baseUrl")).toBeDefined();
  });

  it("trims leading/trailing hyphens from slug", async () => {
    const result = await researchIntegration("---weird---name---");
    expect(result.credentialType).not.toMatch(/^-/);
    expect(result.credentialType).not.toMatch(/-$/);
  });
});
