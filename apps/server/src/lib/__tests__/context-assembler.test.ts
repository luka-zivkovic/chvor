import { describe, expect, it } from "vitest";
import type { ContextAssemblyCandidate } from "@chvor/shared";
import { z } from "zod";
import {
  allocateContextLayerCaps,
  assertContextAttemptFits,
  assembleTurnContext,
  ContextStableOverflowError,
  ContextWindowOverflowError,
  projectToolDefinitionsForContext,
  selectConservativeContextProfile,
} from "../orchestrator/context-assembler.ts";

function humanCandidate(content: string): ContextAssemblyCandidate {
  return {
    id: "human-preference",
    layer: "human",
    owner: "user",
    mutability: "user-editable",
    modelVisibility: "always",
    authority: "user",
    reference: { namespace: "memory-block", id: "block-1", revision: "1" },
    source: { kind: "block", id: "block-1", revision: "1" },
    ordering: { declaredOrder: 1 },
    inclusionReasons: [{ kind: "explicit", code: "configured-profile" }],
    representations: [{ kind: "full", id: "memory-block.full", version: "1", content }],
  };
}

function knowledgeCandidate(content: string): ContextAssemblyCandidate {
  return {
    id: "knowledge-item",
    layer: "knowledge",
    owner: "user",
    mutability: "user-editable",
    modelVisibility: "retrieval-only",
    authority: "untrusted-data",
    reference: { namespace: "graph-memory", id: "knowledge-1", revision: "1" },
    source: { kind: "memory", id: "knowledge-1", revision: "1" },
    ordering: { retrievalScore: 1, eventTime: "2026-07-12T00:00:00.000Z" },
    inclusionReasons: [{ kind: "retrieved", code: "semantic-match", score: 1 }],
    representations: [{ kind: "full", id: "graph-memory.l0", version: "1", content }],
  };
}

describe("server context assembler", () => {
  it("selects the fallback with the least prompt headroom, not the smallest window", () => {
    expect(
      selectConservativeContextProfile([
        { id: "small-window", contextWindowTokens: 32_000, responseReserveTokens: 8_000 },
        { id: "large-reserve", contextWindowTokens: 40_000, responseReserveTokens: 20_000 },
      ]).id
    ).toBe("large-reserve");
  });

  it("accounts for provider-facing JSON schemas and rechecks complete attempts", () => {
    const tools = {
      search: {
        description: "Search safely",
        parameters: z.object({ query: z.string().describe("Search query") }),
      },
    };
    const projected = projectToolDefinitionsForContext(tools);
    expect(projected).toEqual([
      expect.objectContaining({
        name: "search",
        description: "Search safely",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { query: expect.objectContaining({ type: "string" }) },
        }),
      }),
    ]);
    expect(JSON.stringify(projected)).toContain("Search query");

    expect(() =>
      assertContextAttemptFits({
        providerId: "test",
        modelId: "bounded",
        contextWindowTokens: 1_000,
        responseReserveTokens: 100,
        messages: [{ role: "tool", content: "x".repeat(2_000) }],
        toolDefinitions: tools,
      })
    ).toThrow(ContextWindowOverflowError);

    expect(() =>
      assertContextAttemptFits({
        providerId: "test",
        modelId: "bounded",
        contextWindowTokens: 10_000,
        responseReserveTokens: 100,
        messages: [{ role: "user", content: new Uint8Array(1_000_000) }],
        toolDefinitions: {},
      })
    ).not.toThrow();
  });

  it("allocates the exact hierarchy budget with deterministic precedence shares", () => {
    expect(allocateContextLayerCaps(101)).toEqual({
      identity: 20,
      human: 20,
      working: 25,
      procedural: 15,
      episodic: 10,
      knowledge: 11,
    });
  });

  it("reserves all outside-hierarchy inputs and returns a content-free trace", () => {
    const result = assembleTurnContext({
      id: "assembly-1",
      createdAt: "2026-07-12T00:00:00.000Z",
      providerId: "test",
      modelId: "model",
      contextWindowTokens: 4_000,
      responseReserveTokens: 100,
      systemInstructions: "system",
      currentRequest: "what should you remember?",
      toolDefinitions: { tool: { description: "safe" } },
      candidates: [humanCandidate("Prefer Rust for systems work.")],
    });
    expect(result.assembly.layers[1].items[0].content).toBe("Prefer Rust for systems work.");
    expect(result.trace.layers[1].items[0].reference.id).toBe("block-1");
    expect(JSON.stringify(result.trace)).not.toContain("Prefer Rust");
    const configuration = result.assembly.configuration;
    expect(
      configuration.systemInstructionTokens +
        configuration.developerInstructionTokens +
        configuration.currentRequestTokens +
        configuration.otherPromptTokens +
        configuration.responseReserveTokens +
        configuration.toolDefinitionTokens +
        configuration.hierarchyBudgetTokens
    ).toBe(configuration.contextWindowTokens);
  });

  it("uses the same current-media accounting in assembly and first-attempt preflight", () => {
    const result = assembleTurnContext({
      id: "assembly-media",
      createdAt: "2026-07-12T00:00:00.000Z",
      providerId: "test",
      modelId: "bounded",
      contextWindowTokens: 4_000,
      responseReserveTokens: 100,
      systemInstructions: "system",
      currentRequest: "What is this?",
      currentRequestMediaTokens: 1_000,
      toolDefinitions: [],
      candidates: [knowledgeCandidate("x".repeat(1_700))],
    });

    expect(() =>
      assertContextAttemptFits({
        providerId: "test",
        modelId: "bounded",
        contextWindowTokens: 4_000,
        responseReserveTokens: 100,
        messages: [
          { role: "system", content: "system" },
          { role: "system", content: "" },
          { role: "user", content: result.prompt },
          {
            role: "user",
            content: [
              { type: "image", image: new Uint8Array(1), mimeType: "image/png" },
              { type: "text", text: "What is this?" },
            ],
          },
        ],
        toolDefinitions: {},
      })
    ).not.toThrow();
  });

  it("fails explicitly before assembly when reservations exceed the model window", () => {
    expect(() =>
      assembleTurnContext({
        id: "assembly-overflow",
        createdAt: "2026-07-12T00:00:00.000Z",
        providerId: "test",
        modelId: "small",
        contextWindowTokens: 10,
        responseReserveTokens: 5,
        systemInstructions: "system instructions are already too large",
        currentRequest: "request",
        toolDefinitions: {},
        candidates: [],
      })
    ).toThrow(ContextWindowOverflowError);
  });

  it("fails closed with an opaque reference when stable context cannot fit", () => {
    expect(() =>
      assembleTurnContext({
        id: "assembly-stable-overflow",
        createdAt: "2026-07-12T00:00:00.000Z",
        providerId: "test",
        modelId: "small",
        contextWindowTokens: 1_000,
        responseReserveTokens: 10,
        systemInstructions: "system",
        currentRequest: "request",
        toolDefinitions: {},
        candidates: [humanCandidate("PRIVATE_BODY_".repeat(100))],
      })
    ).toThrow(ContextStableOverflowError);
    try {
      assembleTurnContext({
        id: "assembly-stable-overflow-2",
        createdAt: "2026-07-12T00:00:00.000Z",
        providerId: "test",
        modelId: "small",
        contextWindowTokens: 1_000,
        responseReserveTokens: 10,
        systemInstructions: "system",
        currentRequest: "request",
        toolDefinitions: {},
        candidates: [humanCandidate("PRIVATE_BODY_".repeat(100))],
      });
    } catch (error) {
      expect((error as Error).message).toContain("memory-block:block-1@1");
      expect((error as Error).message).not.toContain("PRIVATE_BODY");
    }
  });
});
