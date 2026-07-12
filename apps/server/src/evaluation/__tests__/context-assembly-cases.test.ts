import { describe, expect, it } from "vitest";
import type { ContextAssemblyCandidate } from "@chvor/shared";
import { assembleTurnContext } from "../../lib/orchestrator/context-assembler.ts";

function humanPreference(): ContextAssemblyCandidate {
  return {
    id: "eval-human-rust",
    layer: "human",
    owner: "user",
    mutability: "user-editable",
    modelVisibility: "always",
    authority: "user",
    reference: { namespace: "memory-block", id: "stable-rust", revision: "3" },
    source: { kind: "block", id: "stable-rust", revision: "3" },
    ordering: { declaredOrder: 1 },
    inclusionReasons: [{ kind: "explicit", code: "configured-profile" }],
    representations: [
      {
        kind: "full",
        id: "memory-block.content",
        version: "1",
        content: "The user prefers Rust for systems programming.",
      },
    ],
  };
}

function episode(id: string, score: number, content: string): ContextAssemblyCandidate {
  return {
    id: `eval-${id}`,
    layer: "episodic",
    owner: "user",
    mutability: "user-editable",
    modelVisibility: "retrieval-only",
    authority: "untrusted-data",
    reference: { namespace: "graph-memory", id, revision: "1" },
    source: { kind: "memory", id, revision: "1" },
    ordering: { retrievalScore: score, eventTime: "2026-07-12T00:00:00.000Z" },
    inclusionReasons: [{ kind: "retrieved", code: "semantic-match", score }],
    representations: [{ kind: "full", id: "graph-memory.l0", version: "1", content }],
  };
}

describe("B12 deterministic recall evaluation cases", () => {
  it("recalls a stable preference without any vector candidate", () => {
    const result = assembleTurnContext({
      id: "eval-stable-recall",
      createdAt: "2026-07-12T00:00:00.000Z",
      providerId: "evaluation",
      modelId: "bounded",
      contextWindowTokens: 3_000,
      responseReserveTokens: 100,
      systemInstructions: "Answer using relevant assembled context.",
      currentRequest: "Which language should I use for a systems project?",
      toolDefinitions: {},
      candidates: [humanPreference()],
    });
    expect(result.prompt).toContain("prefers Rust");
    expect(result.trace.layers[1].items[0].reference.id).toBe("stable-rust");
    expect(result.trace.layers[4].items).toHaveLength(0);
  });

  it("keeps the highest-ranked recall target and excludes oversized distractors without overflow", () => {
    const target = episode("target", 0.99, "The deployment codename is Cedar.");
    const distractors = Array.from({ length: 8 }, (_, index) =>
      episode(`distractor-${index}`, 0.5 - index / 100, `d${index}-${"x".repeat(500)}`)
    );
    const result = assembleTurnContext({
      id: "eval-pressure-recall",
      createdAt: "2026-07-12T00:00:00.000Z",
      providerId: "evaluation",
      modelId: "bounded",
      contextWindowTokens: 2_500,
      responseReserveTokens: 100,
      systemInstructions: "Answer using relevant assembled context.",
      currentRequest: "What is the deployment codename?",
      toolDefinitions: {},
      candidates: [humanPreference(), ...distractors.reverse(), target],
    });
    const includedEpisodeIds = result.trace.layers[4].items.map(({ reference }) => reference.id);
    expect(includedEpisodeIds[0]).toBe("target");
    expect(result.prompt).toContain("codename is Cedar");
    expect(result.exclusions.some(({ layer }) => layer === "episodic")).toBe(true);
    expect(JSON.stringify(result.trace)).not.toContain("codename is Cedar");
    const configuration = result.assembly.configuration;
    expect(
      configuration.systemInstructionTokens +
        configuration.currentRequestTokens +
        configuration.otherPromptTokens +
        configuration.responseReserveTokens +
        configuration.toolDefinitionTokens +
        configuration.hierarchyBudgetTokens
    ).toBeLessThanOrEqual(configuration.contextWindowTokens);
  });
});
