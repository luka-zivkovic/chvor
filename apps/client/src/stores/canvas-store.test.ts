import { beforeEach, describe, expect, it } from "vitest";
import type { MultiMindInsight } from "@chvor/shared";
import { BRAIN_NODE_ID, MULTI_MIND_SUMMARY_NODE_ID, useCanvasStore } from "./canvas-store";

function insight(
  overrides: Partial<MultiMindInsight> & Pick<MultiMindInsight, "agentId" | "role">
): MultiMindInsight {
  return {
    title: `${overrides.role} title`,
    text: `${overrides.role} advisory note`,
    durationMs: 42,
    ...overrides,
  };
}

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
  useCanvasStore.getState().initializeEmptyState();
});

describe("canvas-store multi-mind", () => {
  it("adds a synthesis output node and links only successful mind insights", () => {
    const store = useCanvasStore.getState();
    store.upsertMindAgent({ agentId: "r1", role: "researcher", title: "Researcher" });
    store.upsertMindAgent({ agentId: "p1", role: "planner", title: "Planner" });
    store.upsertMindAgent({ agentId: "c1", role: "critic", title: "Critic" });
    store.failMindAgent("c1", "Critic model unavailable.");

    store.completeMultiMindRound(
      [
        insight({ agentId: "r1", role: "researcher", text: "Check source facts." }),
        insight({ agentId: "p1", role: "planner", text: "Sequence the safest path." }),
      ],
      1234
    );

    const { nodes, edges } = useCanvasStore.getState();
    const summary = nodes.find((node) => node.id === MULTI_MIND_SUMMARY_NODE_ID);
    expect(summary).toMatchObject({
      type: "output",
      data: {
        type: "output",
        label: "Mind synthesis",
        source: "multi-mind",
        executionStatus: "completed",
        durationMs: 1234,
      },
    });
    expect(summary?.data.summary).toContain("[researcher] Check source facts.");
    expect(summary?.data.summary).toContain("[planner] Sequence the safest path.");
    expect(summary?.data.summary).not.toContain("[critic]");
    expect(summary?.position.y).toBeGreaterThan(
      nodes.find((node) => node.id === BRAIN_NODE_ID)?.position.y ?? -Infinity
    );
    expect(nodes.find((node) => node.id === "mind-c1")?.data.executionStatus).toBe("failed");
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge-mind-summary-mind-r1",
          source: "mind-r1",
          target: MULTI_MIND_SUMMARY_NODE_ID,
        }),
        expect.objectContaining({
          id: "edge-mind-summary-mind-p1",
          source: "mind-p1",
          target: MULTI_MIND_SUMMARY_NODE_ID,
        }),
      ])
    );
    expect(edges.some((edge) => edge.id === "edge-mind-summary-mind-c1")).toBe(false);
  });

  it("preserves the synthesis node through full canvas reinitialization", () => {
    const store = useCanvasStore.getState();
    store.upsertMindAgent({ agentId: "r1", role: "researcher", title: "Researcher" });
    store.completeMultiMindRound([insight({ agentId: "r1", role: "researcher" })], 10);

    store.initializeFromSkills([]);

    const { nodes, edges } = useCanvasStore.getState();
    expect(nodes.some((node) => node.id === MULTI_MIND_SUMMARY_NODE_ID)).toBe(true);
    expect(nodes.some((node) => node.id === "mind-r1")).toBe(true);
    expect(edges.some((edge) => edge.id === "edge-mind-summary-mind-r1")).toBe(true);
  });

  it("clears the synthesis node with transient mind agents", () => {
    const store = useCanvasStore.getState();
    store.upsertMindAgent({ agentId: "r1", role: "researcher", title: "Researcher" });
    store.completeMultiMindRound([insight({ agentId: "r1", role: "researcher" })], 10);

    store.clearMindAgents();

    const { nodes, edges } = useCanvasStore.getState();
    expect(nodes.some((node) => node.type === "mind-agent")).toBe(false);
    expect(nodes.some((node) => node.id === MULTI_MIND_SUMMARY_NODE_ID)).toBe(false);
    expect(edges.some((edge) => edge.id.startsWith("edge-mind-"))).toBe(false);
  });
});
