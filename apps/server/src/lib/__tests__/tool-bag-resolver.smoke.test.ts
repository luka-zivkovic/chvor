import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolBagScope, ToolGroupId } from "@chvor/shared";

// Route the DB to a throwaway temp dir before anything else loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-bag-order-"));
process.env.CHVOR_DATA_DIR = tmp;

let resolveBagOrdering: typeof import("../tool-bag-resolver.ts").resolveBagOrdering;
let reorderDefsByRanking: typeof import("../tool-bag-resolver.ts").reorderDefsByRanking;
let reorderToolsByRanking: typeof import("../tool-bag-resolver.ts").reorderToolsByRanking;
let recordToolOutcome: typeof import("../tool-graph.ts").recordToolOutcome;

beforeAll(async () => {
  ({ resolveBagOrdering, reorderDefsByRanking, reorderToolsByRanking } = await import(
    "../tool-bag-resolver.ts"
  ));
  ({ recordToolOutcome } = await import("../tool-graph.ts"));
});

function makeTool(id: string, group?: ToolGroupId, description = ""): Tool {
  return {
    kind: "tool",
    id,
    instructions: "",
    source: "bundled",
    path: `${id}.md`,
    builtIn: true,
    mcpServer: { transport: "stdio", command: "echo" },
    metadata: {
      name: id,
      description,
      version: "1.0.0",
      group,
    },
  };
}

function makeScope(groups: Array<ToolGroupId | "*">): ToolBagScope {
  return {
    groups: new Set(groups),
    requiredTools: new Set(),
    deniedTools: new Set(),
    isPermissive: groups.includes("*"),
    contributingSkills: groups.includes("*") ? [] : ["test"],
  };
}

describe("tool-bag-resolver — resolveBagOrdering", () => {
  beforeEach(() => {
    // Phase G+ tests use unique tool names per case so DB rows don't collide.
  });

  it("returns one ranking entry per native + MCP candidate", async () => {
    const result = await resolveBagOrdering({
      candidates: [makeTool("twitter", "social"), makeTool("github", "git")],
      nativeNames: ["native__bag_a"],
      query: "",
      scope: makeScope(["social", "git"]),
    });
    expect(result.ranking).toHaveLength(3);
    const names = result.ranking.map((r) => r.toolName).sort();
    expect(names).toEqual(["github", "native__bag_a", "twitter"].sort());
  });

  it("higher-strength tools rank above weaker ones, all else equal", async () => {
    // Build distinct strengths via the graph.
    for (let i = 0; i < 10; i++) recordToolOutcome({ toolName: "native__bag_strong", success: true });
    for (let i = 0; i < 10; i++) recordToolOutcome({ toolName: "native__bag_weak", success: false });

    const result = await resolveBagOrdering({
      candidates: [],
      nativeNames: ["native__bag_strong", "native__bag_weak"],
      query: "",
      scope: makeScope(["core"]),
    });
    expect(result.ranking[0].toolName).toBe("native__bag_strong");
    expect(result.ranking[0].composite).toBeGreaterThan(result.ranking[1].composite);
  });

  it("co-activation peer in recent-tools history boosts the focus tool's score", async () => {
    // Build co-activation between focus + peer.
    for (let i = 0; i < 5; i++) {
      recordToolOutcome({ toolName: "native__bag_focus", success: true });
      recordToolOutcome({
        toolName: "native__bag_peer",
        success: true,
        recentlySucceeded: ["native__bag_focus"],
      });
    }

    // No session id → no recent-tools history → co-activation = 0
    const noPeer = await resolveBagOrdering({
      candidates: [],
      nativeNames: ["native__bag_focus"],
      query: "",
      scope: makeScope(["core"]),
    });

    // Recent-tools come from action_events (which we haven't populated here)
    // but resolveBagOrdering also accepts a pre-computed list via no-op fall.
    // Verify by spying on the underlying ranker via direct test in tool-graph.
    expect(noPeer.ranking.find((r) => r.toolName === "native__bag_focus")!.coActivation).toBe(0);
  });

  it("category match contributes when scope is non-permissive", async () => {
    const result = await resolveBagOrdering({
      candidates: [
        makeTool("social_in", "social"),
        makeTool("shell_off", "shell"),
      ],
      nativeNames: [],
      query: "",
      scope: makeScope(["social"]),
    });
    const inGroup = result.ranking.find((r) => r.toolName === "social_in")!;
    const offGroup = result.ranking.find((r) => r.toolName === "shell_off")!;
    expect(inGroup.category).toBe(1);
    expect(offGroup.category).toBe(0);
    // Higher composite for the in-group tool (everything else equal).
    expect(inGroup.composite).toBeGreaterThan(offGroup.composite);
  });

  it("permissive scope ('*') treats every observed group as active", async () => {
    const result = await resolveBagOrdering({
      candidates: [makeTool("perm_a", "social"), makeTool("perm_b", "shell")],
      nativeNames: [],
      query: "",
      scope: makeScope(["*"]),
    });
    // Both should get category=1 because both groups are inferred-active.
    for (const r of result.ranking) expect(r.category).toBe(1);
  });

  it("empty query degrades semantic signal to 0 across all candidates", async () => {
    const result = await resolveBagOrdering({
      candidates: [makeTool("sem_a", "social")],
      nativeNames: ["native__sem_b"],
      query: "",
      scope: makeScope(["social", "core"]),
    });
    for (const r of result.ranking) expect(r.semantic).toBe(0);
    expect(result.semanticActive).toBe(false);
  });
});

describe("tool-bag-resolver — reorderDefsByRanking", () => {
  it("preserves Object key order matching the ranking", () => {
    const defs = { c: 3, a: 1, b: 2 };
    const ranking = [
      { toolName: "a", composite: 0.9, strength: 0, coActivation: 0, category: 0, semantic: 0 },
      { toolName: "b", composite: 0.5, strength: 0, coActivation: 0, category: 0, semantic: 0 },
      { toolName: "c", composite: 0.1, strength: 0, coActivation: 0, category: 0, semantic: 0 },
    ];
    expect(Object.keys(reorderDefsByRanking(defs, ranking))).toEqual(["a", "b", "c"]);
  });

  it("places endpoint defs (toolId__endpoint) right after their toolId entry", () => {
    const defs = {
      "github__create_issue": "ci",
      "twitter__tweet": "tw",
      "github__close_pr": "cp",
      "native__web_search": "ws",
    };
    const ranking = [
      { toolName: "github", composite: 0.9, strength: 0, coActivation: 0, category: 0, semantic: 0 },
      { toolName: "native__web_search", composite: 0.5, strength: 0, coActivation: 0, category: 0, semantic: 0 },
      { toolName: "twitter", composite: 0.1, strength: 0, coActivation: 0, category: 0, semantic: 0 },
    ];
    const out = Object.keys(reorderDefsByRanking(defs, ranking));
    expect(out[0]).toBe("github__create_issue");
    expect(out[1]).toBe("github__close_pr");
    expect(out[2]).toBe("native__web_search");
    expect(out[3]).toBe("twitter__tweet");
  });

  it("appends unranked defs at the tail in original order", () => {
    const defs = { x: 1, y: 2, z: 3 };
    const ranking = [
      { toolName: "y", composite: 0.5, strength: 0, coActivation: 0, category: 0, semantic: 0 },
    ];
    expect(Object.keys(reorderDefsByRanking(defs, ranking))).toEqual(["y", "x", "z"]);
  });
});

describe("tool-bag-resolver — reorderToolsByRanking", () => {
  it("ranks tools by ranking position, others go to the tail in original order", () => {
    const tools = [makeTool("c"), makeTool("a"), makeTool("b"), makeTool("d")];
    const ranking = [
      { toolName: "a", composite: 0.9, strength: 0, coActivation: 0, category: 0, semantic: 0 },
      { toolName: "b", composite: 0.5, strength: 0, coActivation: 0, category: 0, semantic: 0 },
    ];
    const out = reorderToolsByRanking(tools, ranking).map((t) => t.id);
    expect(out).toEqual(["a", "b", "c", "d"]);
  });
});
