import { describe, it, expect } from "vitest";
import {
  applyEmotionGate,
  bucketFromVAD,
  defaultRiskForGroup,
  isEmotionGateEnabled,
  lookupToolRisk,
} from "../emotion-gate.ts";
import type { RiskTag } from "@chvor/shared";

function riskMap(entries: Array<[string, RiskTag, boolean?]>): Map<
  string,
  { riskTag: RiskTag; alwaysAvailable: boolean }
> {
  const m = new Map<string, { riskTag: RiskTag; alwaysAvailable: boolean }>();
  for (const [name, riskTag, aa] of entries) {
    m.set(name, { riskTag, alwaysAvailable: !!aa });
  }
  return m;
}

describe("emotion-gate — bucketFromVAD", () => {
  it("hostile when valence ≤ -0.5 AND arousal ≥ 0.4", () => {
    expect(bucketFromVAD({ valence: -0.7, arousal: 0.6 })).toBe("hostile");
    expect(bucketFromVAD({ valence: -0.5, arousal: 0.4 })).toBe("hostile");
  });

  it("frustrated when valence ≤ -0.25 (any arousal) but not hostile", () => {
    expect(bucketFromVAD({ valence: -0.4, arousal: 0 })).toBe("frustrated");
    expect(bucketFromVAD({ valence: -0.4, arousal: 0.3 })).toBe("frustrated");
    // -0.6/-0.4 doesn't satisfy hostile arousal floor → frustrated, not hostile
    expect(bucketFromVAD({ valence: -0.6, arousal: 0.0 })).toBe("frustrated");
  });

  it("collaborative when valence ≥ 0.4 AND arousal ≥ 0.1", () => {
    expect(bucketFromVAD({ valence: 0.5, arousal: 0.3 })).toBe("collaborative");
  });

  it("neutral elsewhere", () => {
    expect(bucketFromVAD({ valence: 0.1, arousal: 0.0 })).toBe("neutral");
    expect(bucketFromVAD({ valence: -0.1, arousal: 0.5 })).toBe("neutral");
    expect(bucketFromVAD({ valence: 0.5, arousal: 0.0 })).toBe("neutral"); // pleasant but quiet
  });
});

describe("emotion-gate — defaultRiskForGroup", () => {
  it("classifies external-effect groups as destructive", () => {
    expect(defaultRiskForGroup("shell")).toBe("destructive");
    expect(defaultRiskForGroup("pc")).toBe("destructive");
    expect(defaultRiskForGroup("sandbox")).toBe("destructive");
    expect(defaultRiskForGroup("credentials")).toBe("destructive");
    expect(defaultRiskForGroup("social")).toBe("destructive");
  });

  it("classifies read-only groups as safe", () => {
    expect(defaultRiskForGroup("core")).toBe("safe");
    expect(defaultRiskForGroup("web")).toBe("safe");
    expect(defaultRiskForGroup("a2ui")).toBe("safe");
    expect(defaultRiskForGroup("model")).toBe("safe");
  });

  it("falls back to moderate for undeclared groups", () => {
    expect(defaultRiskForGroup(undefined)).toBe("moderate");
    expect(defaultRiskForGroup("integrations-other")).toBe("moderate");
  });
});

describe("emotion-gate — lookupToolRisk", () => {
  const map = riskMap([
    ["native__web_search", "safe"],
    ["native__shell_execute", "destructive"],
    ["native__recall_detail", "safe", true],
    ["github", "destructive"], // MCP toolId-prefix entry
  ]);

  it("returns exact-match entry first", () => {
    expect(lookupToolRisk("native__web_search", map).riskTag).toBe("safe");
    expect(lookupToolRisk("native__recall_detail", map).alwaysAvailable).toBe(true);
  });

  it("falls through to toolId prefix for MCP/synth endpoints", () => {
    expect(lookupToolRisk("github__create_issue", map).riskTag).toBe("destructive");
    expect(lookupToolRisk("github__delete_repo", map).riskTag).toBe("destructive");
  });

  it("returns conservative `moderate` for unknown tools", () => {
    expect(lookupToolRisk("unknown__tool", map).riskTag).toBe("moderate");
  });
});

describe("emotion-gate — applyEmotionGate", () => {
  const defs = {
    "native__web_search": "w",
    "native__shell_execute": "s",
    "native__recall_detail": "r",
    "native__skill_create": "k",
  };
  const map = riskMap([
    ["native__web_search", "safe"],
    ["native__shell_execute", "destructive"],
    ["native__recall_detail", "safe", true],
    ["native__skill_create", "moderate"],
  ]);

  it("no-op when neutral", () => {
    const r = applyEmotionGate({
      defs,
      vad: { valence: 0, arousal: 0, dominance: 0 },
      riskMap: map,
    });
    expect(r.bucket).toBe("neutral");
    expect(r.event).toBeNull();
    expect(Object.keys(r.defs).sort()).toEqual(Object.keys(defs).sort());
  });

  it("no-op when collaborative", () => {
    const r = applyEmotionGate({
      defs,
      vad: { valence: 0.6, arousal: 0.3, dominance: 0 },
      riskMap: map,
    });
    expect(r.bucket).toBe("collaborative");
    expect(r.masked).toEqual([]);
  });

  it("frustrated masks destructive tools but keeps moderate + safe", () => {
    const r = applyEmotionGate({
      defs,
      vad: { valence: -0.4, arousal: 0, dominance: 0 },
      riskMap: map,
    });
    expect(r.bucket).toBe("frustrated");
    expect(r.masked.map((m) => m.toolName)).toEqual(["native__shell_execute"]);
    expect(Object.keys(r.defs).sort()).toEqual([
      "native__recall_detail",
      "native__skill_create",
      "native__web_search",
    ]);
    expect(r.event).not.toBeNull();
    expect(r.event!.toolCountAfter).toBe(3);
  });

  it("hostile masks destructive AND moderate, keeping safe", () => {
    const r = applyEmotionGate({
      defs,
      vad: { valence: -0.7, arousal: 0.6, dominance: 0 },
      riskMap: map,
    });
    expect(r.bucket).toBe("hostile");
    const maskedNames = r.masked.map((m) => m.toolName).sort();
    expect(maskedNames).toEqual(["native__shell_execute", "native__skill_create"]);
    expect(r.event!.reason).toContain("cooling-off");
  });

  it("always-available tools bypass the gate", () => {
    const aaDefs = {
      "native__shell_execute": "s",
      "native__recall_detail": "r",
    };
    const aaMap = riskMap([
      ["native__shell_execute", "destructive"],
      ["native__recall_detail", "safe", true], // always-available
    ]);
    // Even more aggressively: tag recall as destructive but always-available
    // to prove the bypass path.
    const aggressive = riskMap([
      ["native__shell_execute", "destructive"],
      ["native__recall_detail", "destructive", true],
    ]);
    const r = applyEmotionGate({
      defs: aaDefs,
      vad: { valence: -0.8, arousal: 0.7, dominance: 0 },
      riskMap: aggressive,
    });
    // recall stays in the bag because criticality === always-available
    expect(Object.keys(r.defs)).toContain("native__recall_detail");
    expect(r.bypassed).toContain("native__recall_detail");
    // shell still gets masked
    expect(Object.keys(r.defs)).not.toContain("native__shell_execute");

    // sanity: same defs without aa flag → recall would be masked
    const r2 = applyEmotionGate({
      defs: { "native__recall_detail": "r" },
      vad: { valence: -0.8, arousal: 0.7, dominance: 0 },
      riskMap: riskMap([["native__recall_detail", "destructive"]]),
    });
    expect(Object.keys(r2.defs)).not.toContain("native__recall_detail");

    void aaMap;
  });

  it("treats null VAD as neutral (no gating)", () => {
    const r = applyEmotionGate({ defs, vad: null, riskMap: map });
    expect(r.bucket).toBe("neutral");
    expect(r.event).toBeNull();
  });
});

describe("emotion-gate — settings", () => {
  it("isEmotionGateEnabled defaults true and respects opt-out env values", () => {
    const original = process.env.CHVOR_EMOTION_GATE;
    try {
      delete process.env.CHVOR_EMOTION_GATE;
      expect(isEmotionGateEnabled()).toBe(true);
      for (const off of ["0", "false", "off", "no", "OFF", "False"]) {
        process.env.CHVOR_EMOTION_GATE = off;
        expect(isEmotionGateEnabled()).toBe(false);
      }
      for (const on of ["1", "true", "yes", "anything"]) {
        process.env.CHVOR_EMOTION_GATE = on;
        expect(isEmotionGateEnabled()).toBe(true);
      }
    } finally {
      if (original === undefined) delete process.env.CHVOR_EMOTION_GATE;
      else process.env.CHVOR_EMOTION_GATE = original;
    }
  });
});
