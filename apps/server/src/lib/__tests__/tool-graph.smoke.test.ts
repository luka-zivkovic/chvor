import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the DB to a throwaway temp dir before anything else loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-graph-"));
process.env.CHVOR_DATA_DIR = tmp;

let recordToolOutcome: typeof import("../tool-graph.ts").recordToolOutcome;
let rankTools: typeof import("../tool-graph.ts").rankTools;
let scoreTool: typeof import("../tool-graph.ts").scoreTool;
let decayStrengths: typeof import("../tool-graph.ts").decayStrengths;
let constants: typeof import("../tool-graph.ts");
let getNode: typeof import("../../db/tool-graph-store.ts").getNode;
let listNodes: typeof import("../../db/tool-graph-store.ts").listNodes;
let getEdgesAmong: typeof import("../../db/tool-graph-store.ts").getEdgesAmong;
let countNodes: typeof import("../../db/tool-graph-store.ts").countNodes;
let pairKey: typeof import("../../db/tool-graph-store.ts").pairKey;

beforeAll(async () => {
  constants = await import("../tool-graph.ts");
  ({ recordToolOutcome, rankTools, scoreTool, decayStrengths } = constants);
  ({ getNode, listNodes, getEdgesAmong, countNodes, pairKey } = await import("../../db/tool-graph-store.ts"));
});

describe("tool-graph — recordToolOutcome", () => {
  // Test isolation: each case uses a unique tool name (native__t_strength,
  // native__t_hebb_a, ...) so DB rows never collide between tests.

  it("creates a node lazily on first observation, with trial-boost + initial strength", () => {
    const before = countNodes();
    const result = recordToolOutcome({ toolName: "native__t_first", success: true });
    expect(countNodes()).toBe(before + 1);
    expect(result.before.invocationCount).toBe(0);
    expect(result.after.invocationCount).toBe(1);
    expect(result.after.successCount).toBe(1);
    expect(result.after.failureCount).toBe(0);
    expect(result.after.strength).toBeGreaterThan(constants.INITIAL_STRENGTH);
    expect(result.after.trialBoostRemaining).toBe(constants.DEFAULT_TRIAL_BOOST - 1);
  });

  it("strength rises on success, falls on failure, never below floor", () => {
    const tool = "native__t_strength";
    // 5 successes → near ceiling
    for (let i = 0; i < 5; i++) recordToolOutcome({ toolName: tool, success: true });
    const peak = getNode(tool)!;
    expect(peak.strength).toBeLessThanOrEqual(constants.STRENGTH_CEILING);
    expect(peak.strength).toBeGreaterThan(constants.INITIAL_STRENGTH);

    // 30 failures should saturate at floor
    for (let i = 0; i < 30; i++) recordToolOutcome({ toolName: tool, success: false });
    const drained = getNode(tool)!;
    expect(drained.strength).toBeCloseTo(constants.STRENGTH_FLOOR, 5);
    expect(drained.failureCount).toBe(30);
  });

  it("forms Hebbian co-activation edges between successes in the same turn", () => {
    const a = "native__t_hebb_a";
    const b = "native__t_hebb_b";
    const c = "native__t_hebb_c";
    // Turn 1: a then b succeed → one edge (a,b)
    recordToolOutcome({ toolName: a, success: true });
    const r2 = recordToolOutcome({ toolName: b, success: true, recentlySucceeded: [a] });
    expect(r2.edgesBumped).toEqual([{ a, b }]);

    // Turn 2: a then c succeed → new edge (a,c)
    const r3 = recordToolOutcome({ toolName: c, success: true, recentlySucceeded: [a] });
    expect(r3.edgesBumped).toEqual([pairKey(a, c)].map(([x, y]) => ({ a: x, b: y })));

    // Edge weights monotone-increasing on repeat co-uses
    const before = getEdgesAmong([a, b])[0].weight;
    recordToolOutcome({ toolName: b, success: true, recentlySucceeded: [a] });
    const after = getEdgesAmong([a, b])[0].weight;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1.0);
  });

  it("does NOT form an edge when peer wasn't successful (failure path is silent)", () => {
    const a = "native__t_silent_a";
    const b = "native__t_silent_b";
    const r = recordToolOutcome({ toolName: a, success: false, recentlySucceeded: [b] });
    expect(r.edgesBumped).toHaveLength(0);
  });
});

describe("tool-graph — scoring + ranking", () => {
  it("higher-strength tools outrank lower-strength tools all else equal", () => {
    const strong = "native__t_strong";
    const weak = "native__t_weak";
    for (let i = 0; i < 10; i++) recordToolOutcome({ toolName: strong, success: true });
    for (let i = 0; i < 10; i++) recordToolOutcome({ toolName: weak, success: false });

    const ranking = rankTools([strong, weak]);
    expect(ranking[0].toolName).toBe(strong);
    expect(ranking[0].composite).toBeGreaterThan(ranking[1].composite);
  });

  it("co-activation boosts a tool's score when one of its edge-peers is recently used", () => {
    const focus = "native__t_focus";
    const peer = "native__t_peer";
    const lonely = "native__t_lonely";

    // Build co-activation between focus + peer; lonely sits with no edges.
    for (let i = 0; i < 5; i++) {
      recordToolOutcome({ toolName: focus, success: true });
      recordToolOutcome({ toolName: peer, success: true, recentlySucceeded: [focus] });
    }
    // Match strengths so the only differentiator is co-activation.
    for (let i = 0; i < 10; i++) recordToolOutcome({ toolName: lonely, success: true });

    const noPeer = rankTools([focus, lonely], {});
    const withPeer = rankTools([focus, lonely], { recentTools: [peer] });

    const focusNoPeer = noPeer.find((r) => r.toolName === focus)!;
    const focusWithPeer = withPeer.find((r) => r.toolName === focus)!;
    expect(focusWithPeer.coActivation).toBeGreaterThan(focusNoPeer.coActivation);
  });

  it("category match contributes when activeGroups + groupOf are provided", () => {
    const inGroup = "native__t_in";
    const offGroup = "native__t_off";
    recordToolOutcome({ toolName: inGroup, success: true });
    recordToolOutcome({ toolName: offGroup, success: true });

    const ranking = rankTools([inGroup, offGroup], {
      activeGroups: ["web"],
      groupOf: (n) => (n === inGroup ? "web" : "shell"),
    });
    expect(ranking[0].toolName).toBe(inGroup);
    expect(ranking[0].category).toBe(1);
    expect(ranking[1].category).toBe(0);
  });

  it("scoreTool returns a neutral signal for unknown nodes (no harsh penalty for cold-start)", () => {
    const score = scoreTool(null, "fresh-tool", new Map(), {});
    // strength=0.5 (neutral), coActivation=0, category=0 → composite around 0.25
    expect(score.strength).toBe(0.5);
    expect(score.composite).toBeGreaterThanOrEqual(0.2);
    expect(score.composite).toBeLessThanOrEqual(0.3);
  });
});

describe("tool-graph — decayStrengths", () => {
  it("decays every node toward the floor, never below it", () => {
    const a = "native__t_decay_a";
    const b = "native__t_decay_b";
    for (let i = 0; i < 5; i++) recordToolOutcome({ toolName: a, success: true });
    for (let i = 0; i < 5; i++) recordToolOutcome({ toolName: b, success: true });

    const before = listNodes(1000).filter((n) => n.toolName === a || n.toolName === b);
    decayStrengths();
    const after = listNodes(1000).filter((n) => n.toolName === a || n.toolName === b);

    for (const node of after) {
      const prev = before.find((p) => p.toolName === node.toolName)!;
      expect(node.strength).toBeLessThanOrEqual(prev.strength);
      expect(node.strength).toBeGreaterThanOrEqual(constants.STRENGTH_FLOOR);
    }
  });
});
