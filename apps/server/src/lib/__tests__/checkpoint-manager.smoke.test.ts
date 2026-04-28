import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolBagScope } from "@chvor/shared";

// Route the DB to a throwaway temp dir before anything loads the singleton.
const tmp = mkdtempSync(join(tmpdir(), "chvor-checkpoint-"));
process.env.CHVOR_DATA_DIR = tmp;

let snapshotRound: typeof import("../checkpoint-manager.ts").snapshotRound;
let isCheckpointingEnabled: typeof import("../checkpoint-manager.ts").isCheckpointingEnabled;
let appendCheckpoint: typeof import("../../db/checkpoint-store.ts").appendCheckpoint;
let getCheckpoint: typeof import("../../db/checkpoint-store.ts").getCheckpoint;
let getLatestCheckpointForSession: typeof import("../../db/checkpoint-store.ts").getLatestCheckpointForSession;
let listCheckpointSummaries: typeof import("../../db/checkpoint-store.ts").listCheckpointSummaries;
let pruneCheckpointsOlderThan: typeof import("../../db/checkpoint-store.ts").pruneCheckpointsOlderThan;
let countCheckpoints: typeof import("../../db/checkpoint-store.ts").countCheckpoints;

beforeAll(async () => {
  ({ snapshotRound, isCheckpointingEnabled } = await import(
    "../checkpoint-manager.ts"
  ));
  ({
    appendCheckpoint,
    getCheckpoint,
    getLatestCheckpointForSession,
    listCheckpointSummaries,
    pruneCheckpointsOlderThan,
    countCheckpoints,
  } = await import("../../db/checkpoint-store.ts"));
});

function makeScope(): ToolBagScope {
  return {
    groups: new Set(["core", "web"]),
    requiredTools: new Set(["native__recall"]),
    deniedTools: new Set(["native__shell_execute"]),
    isPermissive: false,
    contributingSkills: ["test-skill"],
  };
}

describe("checkpoint-manager — snapshotRound", () => {
  it("is enabled by default and disabled when env flag is set", () => {
    const original = process.env.CHVOR_CHECKPOINT_DISABLE;
    delete process.env.CHVOR_CHECKPOINT_DISABLE;
    expect(isCheckpointingEnabled()).toBe(true);

    process.env.CHVOR_CHECKPOINT_DISABLE = "1";
    expect(isCheckpointingEnabled()).toBe(false);

    process.env.CHVOR_CHECKPOINT_DISABLE = "true";
    expect(isCheckpointingEnabled()).toBe(false);

    if (original === undefined) delete process.env.CHVOR_CHECKPOINT_DISABLE;
    else process.env.CHVOR_CHECKPOINT_DISABLE = original;
  });

  it("returns null when sessionId is missing", () => {
    const id = snapshotRound({
      sessionId: undefined,
      round: 0,
      bagScope: makeScope(),
      bagToolCount: 5,
      emotion: null,
      model: { providerId: "anthropic", model: "claude-x", wasFallback: false },
      ranking: [],
      toolOutcomes: [],
      recentTools: [],
      messages: { total: 0, fitted: 0 },
      memoryIds: [],
    });
    expect(id).toBeNull();
  });

  it("persists a row and round-trips the snapshot through getCheckpoint", () => {
    const sessionId = "sess-roundtrip";
    const id = snapshotRound({
      sessionId,
      round: 2,
      bagScope: makeScope(),
      bagToolCount: 7,
      emotion: {
        bucket: "frustrated",
        vad: { valence: -0.4, arousal: 0.6, dominance: 0.0 },
        maskedToolCount: 2,
      },
      model: { providerId: "openai", model: "gpt-X", wasFallback: true },
      ranking: [
        { toolName: "native__a", composite: 0.42 },
        { toolName: "native__b", composite: 0.31 },
      ],
      toolOutcomes: [
        { toolName: "native__a", success: true },
        { toolName: "native__b", success: false },
      ],
      recentTools: ["native__a"],
      messages: { total: 12, fitted: 10 },
      memoryIds: ["mem-1", "mem-2"],
    });
    expect(id).toBeTypeOf("string");

    const ck = getCheckpoint(id!);
    expect(ck).not.toBeNull();
    expect(ck!.round).toBe(2);
    expect(ck!.sessionId).toBe(sessionId);
    // Bag fields are sorted on the way in for deterministic JSON.
    expect(ck!.state.bag.groups).toEqual(["core", "web"]);
    expect(ck!.state.bag.contributingSkills).toEqual(["test-skill"]);
    expect(ck!.state.bag.deniedTools).toEqual(["native__shell_execute"]);
    expect(ck!.state.bag.requiredTools).toEqual(["native__recall"]);
    expect(ck!.state.bag.toolCount).toBe(7);
    expect(ck!.state.emotion?.bucket).toBe("frustrated");
    expect(ck!.state.model.wasFallback).toBe(true);
    expect(ck!.state.ranking).toHaveLength(2);
    expect(ck!.state.toolOutcomes).toHaveLength(2);
    expect(ck!.state.recentTools).toEqual(["native__a"]);
    expect(ck!.state.messages).toEqual({ total: 12, fitted: 10 });
    expect(ck!.state.memoryIds).toEqual(["mem-1", "mem-2"]);
  });

  it("caps ranking, recentTools, and memoryIds to keep snapshots small", () => {
    const sessionId = "sess-caps";
    const ranking = Array.from({ length: 50 }, (_, i) => ({
      toolName: `native__r_${i}`,
      composite: 1 - i * 0.01,
    }));
    const recentTools = Array.from({ length: 50 }, (_, i) => `native__rec_${i}`);
    const memoryIds = Array.from({ length: 50 }, (_, i) => `mem-${i}`);

    const id = snapshotRound({
      sessionId,
      round: 0,
      bagScope: makeScope(),
      bagToolCount: 1,
      emotion: null,
      model: { providerId: "x", model: "y", wasFallback: false },
      ranking,
      toolOutcomes: [],
      recentTools,
      messages: { total: 0, fitted: 0 },
      memoryIds,
    });
    const ck = getCheckpoint(id!);
    expect(ck!.state.ranking).toHaveLength(12);
    expect(ck!.state.recentTools).toHaveLength(20);
    expect(ck!.state.memoryIds).toHaveLength(30);
  });

  it("listCheckpointSummaries filters by session and is paginated", () => {
    const sessionA = "sess-list-a";
    const sessionB = "sess-list-b";
    for (let i = 0; i < 3; i++) {
      snapshotRound({
        sessionId: sessionA,
        round: i,
        bagScope: makeScope(),
        bagToolCount: 0,
        emotion: null,
        model: { providerId: "x", model: "y", wasFallback: false },
        ranking: [],
        toolOutcomes: [],
        recentTools: [],
        messages: { total: 0, fitted: 0 },
        memoryIds: [],
      });
    }
    snapshotRound({
      sessionId: sessionB,
      round: 0,
      bagScope: makeScope(),
      bagToolCount: 0,
      emotion: null,
      model: { providerId: "x", model: "y", wasFallback: false },
      ranking: [],
      toolOutcomes: [],
      recentTools: [],
      messages: { total: 0, fitted: 0 },
      memoryIds: [],
    });

    const a = listCheckpointSummaries({ sessionId: sessionA });
    expect(a.every((r) => r.sessionId === sessionA)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(3);
    const limited = listCheckpointSummaries({ sessionId: sessionA, limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("getLatestCheckpointForSession returns the most recent round", () => {
    const sessionId = "sess-latest";
    snapshotRound({
      sessionId,
      round: 0,
      bagScope: makeScope(),
      bagToolCount: 0,
      emotion: null,
      model: { providerId: "x", model: "y", wasFallback: false },
      ranking: [],
      toolOutcomes: [],
      recentTools: [],
      messages: { total: 0, fitted: 0 },
      memoryIds: [],
    });
    snapshotRound({
      sessionId,
      round: 1,
      bagScope: makeScope(),
      bagToolCount: 0,
      emotion: null,
      model: { providerId: "x", model: "y", wasFallback: false },
      ranking: [],
      toolOutcomes: [{ toolName: "native__final", success: true }],
      recentTools: [],
      messages: { total: 0, fitted: 0 },
      memoryIds: [],
    });
    const latest = getLatestCheckpointForSession(sessionId);
    expect(latest).not.toBeNull();
    expect(latest!.round).toBe(1);
    expect(latest!.state.toolOutcomes[0].toolName).toBe("native__final");
  });

  it("pruneCheckpointsOlderThan keeps fresh rows and sweeps when horizon is short", () => {
    const sessionId = "sess-prune";
    appendCheckpoint(sessionId, {
      round: 0,
      bag: {
        groups: [],
        contributingSkills: [],
        isPermissive: true,
        deniedTools: [],
        requiredTools: [],
        toolCount: 0,
      },
      emotion: null,
      model: { providerId: "x", model: "y", wasFallback: false },
      ranking: [],
      toolOutcomes: [],
      recentTools: [],
      messages: { total: 0, fitted: 0 },
      memoryIds: [],
    });
    // 1-day horizon: nothing we just wrote is that old, so noop.
    const removedNoop = pruneCheckpointsOlderThan(24 * 60 * 60 * 1000);
    expect(removedNoop).toBe(0);

    // Negative horizon → cutoff sits in the future → every row is "older".
    const totalBefore = countCheckpoints();
    const removed = pruneCheckpointsOlderThan(-1);
    expect(removed).toBe(totalBefore);
    expect(countCheckpoints()).toBe(0);
  });
});
