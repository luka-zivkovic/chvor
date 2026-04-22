import { describe, it, expect } from "vitest";
import {
  computeOrbitalPositions,
  HUB_SLOT_ANGLE,
  HUB_SLOT_COUNT,
  INNER_RADIUS,
  OFFSETS,
} from "../orbital-geometry";
import type { Skill, Tool, Schedule, WebhookSubscription, CredentialSummary } from "@chvor/shared";

const skill = (id: string, name = id): Skill => ({
  id,
  enabled: true,
  source: "user",
  pluginId: null,
  builtIn: false,
  metadata: { name, description: "", category: "general", icon: "", trigger: "", tags: [] },
} as unknown as Skill);

const tool = (id: string, name = id): Tool => ({
  id,
  enabled: true,
  source: "user",
  pluginId: null,
  builtIn: false,
  metadata: { name, description: "", category: "general", icon: "", trigger: "", tags: [] },
} as unknown as Tool);

const sched = (id: string): Schedule => ({ id, name: id } as unknown as Schedule);
const cred = (id: string, name = id): CredentialSummary =>
  ({ id, name, type: "openai" } as unknown as CredentialSummary);
const webhook = (id: string): WebhookSubscription => ({ id, url: "" } as unknown as WebhookSubscription);

describe("computeOrbitalPositions", () => {
  it("returns brain at hexagon slot 0 (12 o'clock, offset by half-size)", () => {
    const layout = computeOrbitalPositions([], [], [], [], []);
    const slot0 = HUB_SLOT_ANGLE(0);
    expect(layout.brainPos.x).toBeCloseTo(Math.cos(slot0) * INNER_RADIUS - OFFSETS.brain.hw, 4);
    expect(layout.brainPos.y).toBeCloseTo(Math.sin(slot0) * INNER_RADIUS - OFFSETS.brain.hh, 4);
  });

  it("places skills-hub at canvas center (occupies the slot brain vacated)", () => {
    const layout = computeOrbitalPositions([], [], [], [], []);
    const skillsHub = layout.hubPositions.get("skills-hub");
    expect(skillsHub).toEqual({ x: -OFFSETS.hub.hw, y: -OFFSETS.hub.hh });
  });

  it("places all six hubs", () => {
    const layout = computeOrbitalPositions([], [], [], [], []);
    expect(layout.hubPositions.size).toBe(HUB_SLOT_COUNT);
    expect([...layout.hubPositions.keys()].sort()).toEqual(
      ["connections-hub", "integrations-hub", "schedule-hub", "skills-hub", "tools-hub", "webhooks-hub"]
    );
  });

  it("returns no fan-out positions when domains are empty", () => {
    const layout = computeOrbitalPositions([], [], [], [], []);
    expect(layout.skillPositions.size).toBe(0);
    expect(layout.toolPositions.size).toBe(0);
    expect(layout.schedulePositions.size).toBe(0);
    expect(layout.channelPositions.size).toBe(0);
    expect(layout.apiPositions.size).toBe(0);
    expect(layout.webhookPositions.size).toBe(0);
  });

  it("fans out skills with one position per skill", () => {
    const skills = [skill("s1"), skill("s2"), skill("s3")];
    const layout = computeOrbitalPositions(skills, [], [], [], []);
    expect(layout.skillPositions.size).toBe(3);
    expect(layout.skillPositions.has("skill-s1")).toBe(true);
    expect(layout.skillPositions.has("skill-s2")).toBe(true);
    expect(layout.skillPositions.has("skill-s3")).toBe(true);
  });

  it("respects savedPositions overrides for hubs and brain", () => {
    const saved = new Map<string, { x: number; y: number }>([
      ["brain-0", { x: 999, y: 999 }],
      ["tools-hub", { x: 111, y: 222 }],
    ]);
    const layout = computeOrbitalPositions([], [], [], [], [], saved);
    expect(layout.brainPos).toEqual({ x: 999, y: 999 });
    expect(layout.hubPositions.get("tools-hub")).toEqual({ x: 111, y: 222 });
  });

  it("respects savedPositions overrides for fan-out items", () => {
    const skills = [skill("s1")];
    const saved = new Map<string, { x: number; y: number }>([
      ["skill-s1", { x: 50, y: -50 }],
    ]);
    const layout = computeOrbitalPositions(skills, [], [], [], [], saved);
    expect(layout.skillPositions.get("skill-s1")).toEqual({ x: 50, y: -50 });
  });

  it("places single-item fan-out at the hub angle (no spread)", () => {
    const layout = computeOrbitalPositions([], [tool("t1")], [], [], []);
    const pos = layout.toolPositions.get("tool-t1");
    expect(pos).toBeDefined();
    // Position should be radially outward from the tools-hub center
    const hubPos = layout.hubPositions.get("tools-hub")!;
    const hubCx = hubPos.x + OFFSETS.hub.hw;
    const hubCy = hubPos.y + OFFSETS.hub.hh;
    const itemCx = pos!.x + OFFSETS.tool.hw;
    const itemCy = pos!.y + OFFSETS.tool.hh;
    const dx = itemCx - hubCx;
    const dy = itemCy - hubCy;
    const distance = Math.sqrt(dx * dx + dy * dy);
    expect(distance).toBeGreaterThan(100); // BASE_FAN_RADIUS = 180
  });

  it("grows fan radius for crowded hubs", () => {
    // 3 items uses base radius; >3 items grows it
    const small = computeOrbitalPositions(
      [skill("a"), skill("b"), skill("c")],
      [], [], [], []
    );
    const large = computeOrbitalPositions(
      Array.from({ length: 10 }, (_, i) => skill(`s${i}`)),
      [], [], [], []
    );
    const skillsHub = small.hubPositions.get("skills-hub")!;
    const hubCx = skillsHub.x + OFFSETS.hub.hw;
    const hubCy = skillsHub.y + OFFSETS.hub.hh;
    const distOf = (m: Map<string, { x: number; y: number }>, key: string) => {
      const p = m.get(key)!;
      const dx = p.x + OFFSETS.skill.hw - hubCx;
      const dy = p.y + OFFSETS.skill.hh - hubCy;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const smallDist = distOf(small.skillPositions, "skill-a");
    const largeDist = distOf(large.skillPositions, "skill-s0");
    expect(largeDist).toBeGreaterThan(smallDist);
  });

  it("supports schedules, channels, apis, and webhooks domains", () => {
    const layout = computeOrbitalPositions(
      [],
      [],
      [sched("sc1")],
      [cred("c1")],
      [cred("a1")],
      undefined,
      [webhook("w1")]
    );
    expect(layout.schedulePositions.has("schedule-sc1")).toBe(true);
    expect(layout.channelPositions.has("channel-c1")).toBe(true);
    expect(layout.apiPositions.has("api-a1")).toBe(true);
    expect(layout.webhookPositions.has("webhook-w1")).toBe(true);
  });

  it("is deterministic — same inputs produce same outputs", () => {
    const args: Parameters<typeof computeOrbitalPositions> = [
      [skill("a"), skill("b")],
      [tool("t1")],
      [sched("s1")],
      [],
      [],
    ];
    const a = computeOrbitalPositions(...args);
    const b = computeOrbitalPositions(...args);
    expect(a.brainPos).toEqual(b.brainPos);
    expect([...a.skillPositions]).toEqual([...b.skillPositions]);
    expect([...a.toolPositions]).toEqual([...b.toolPositions]);
  });
});
