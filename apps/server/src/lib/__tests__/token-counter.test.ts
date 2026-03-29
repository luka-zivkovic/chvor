import { describe, it, expect } from "vitest";
import type { MediaArtifact } from "@chvor/shared";
import { estimateTokens, estimateMediaTokens, fitMessagesToBudget } from "../token-counter.ts";

const media = (type: MediaArtifact["mediaType"]): MediaArtifact => ({
  id: "m1", url: "x", mimeType: "application/octet-stream", mediaType: type,
});

describe("estimateTokens", () => {
  it("estimates tokens as chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hi")).toBe(1);
    expect(estimateTokens("hello")).toBe(2); // 5/4 = 1.25 → 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("a".repeat(101))).toBe(26);
  });
});

describe("estimateMediaTokens", () => {
  it("returns 0 for no media", () => {
    expect(estimateMediaTokens(undefined)).toBe(0);
    expect(estimateMediaTokens([])).toBe(0);
  });

  it("estimates image tokens", () => {
    expect(estimateMediaTokens([media("image")])).toBe(1000);
  });

  it("estimates video tokens", () => {
    expect(estimateMediaTokens([media("video")])).toBe(2500);
  });

  it("estimates audio tokens", () => {
    expect(estimateMediaTokens([media("audio")])).toBe(500);
  });

  it("sums multiple media types", () => {
    expect(estimateMediaTokens([media("image"), media("video"), media("audio")])).toBe(4000);
  });
});

describe("fitMessagesToBudget", () => {
  const msg = (content: string, tokenCount?: number) => ({ content, tokenCount });

  it("returns all messages when they fit", () => {
    const msgs = [msg("a".repeat(40)), msg("b".repeat(40))]; // 10 + 10 = 20 tokens
    expect(fitMessagesToBudget(msgs, 100)).toHaveLength(2);
  });

  it("keeps most recent messages when budget exceeded", () => {
    const msgs = [
      msg("old", 50),
      msg("middle", 50),
      msg("recent", 50),
    ];
    const result = fitMessagesToBudget(msgs, 100);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("middle");
    expect(result[1].content).toBe("recent");
  });

  it("always includes at least the last message", () => {
    const msgs = [msg("huge", 9999)];
    const result = fitMessagesToBudget(msgs, 10);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("huge");
  });

  it("uses estimateTokens when tokenCount not provided", () => {
    // "a" * 400 = 100 tokens estimated
    const msgs = [msg("a".repeat(400)), msg("b".repeat(400))]; // 100 + 100
    const result = fitMessagesToBudget(msgs, 150);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("b".repeat(400));
  });

  it("handles empty messages array", () => {
    expect(fitMessagesToBudget([], 100)).toEqual([]);
  });

  it("accounts for media tokens in budget", () => {
    const msgs = [
      { content: "text", tokenCount: 10, media: [media("image")] }, // 10 + 1000 = 1010
      { content: "last", tokenCount: 10 },
    ];
    const result = fitMessagesToBudget(msgs, 100);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("last");
  });
});
