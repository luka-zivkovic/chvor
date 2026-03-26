/**
 * Orbital Layout Engine
 *
 * Computes positions for canvas nodes in concentric rings:
 *   Center (r=0):   Brain node (180px)
 *   Inner ring (r=210): Hub nodes in fixed hexagon slots starting from 12 o'clock
 *   Fan-out (r=150 from hub): Individual items fan out from their parent hub
 *
 * Hub positions are FIXED slots — adding/removing hubs doesn't shift existing ones.
 * Order (clockwise from top): Skills, Tools, Schedules, Integrations, Connections, Webhooks
 */

import type { Skill, Tool, Schedule, WebhookSubscription, CredentialSummary } from "@chvor/shared";

export interface OrbitalPosition {
  x: number;
  y: number;
}

// Half-size offsets (visual center → top-left for React Flow positioning)
export const OFFSETS = {
  brain: { hw: 90, hh: 110 },
  hub: { hw: 45, hh: 47 },
  skill: { hw: 45, hh: 47 },
  tool: { hw: 45, hh: 47 },
  schedule: { hw: 40, hh: 36 },
  integration: { hw: 45, hh: 47 },
  webhook: { hw: 40, hh: 36 },
};

export const INNER_RADIUS = 240;
const BASE_FAN_RADIUS = 180;

// Fixed hexagon: 6 slots at 60° intervals starting from 12 o'clock (-π/2)
export const HUB_SLOT_COUNT = 6;
export const HUB_SLOT_ANGLE = (slot: number) => -Math.PI / 2 + (2 * Math.PI * slot) / HUB_SLOT_COUNT;
const SLOT_GAP = (2 * Math.PI) / HUB_SLOT_COUNT;

// Dynamic radius: grows when a hub has many items to prevent crowding
function computeFanRadius(itemCount: number): number {
  if (itemCount <= 3) return BASE_FAN_RADIUS;
  return BASE_FAN_RADIUS + (itemCount - 3) * 40;
}

// Dynamic arc: widens up to 90% of slot gap to fit more items
function computeFanArc(itemCount: number, fanRadius: number): number {
  const maxArc = SLOT_GAP * 0.95;
  // Desired: enough for ~105px gap between node centers (nodes are ~90px wide)
  const desiredArc = itemCount <= 1 ? 0 : (itemCount - 1) * (105 / fanRadius);
  return Math.min(desiredArc, maxArc);
}

interface HubConfig {
  id: string;
  type: string;
  slot: number; // fixed pentagon slot index
  exists: boolean;
}

export function computeOrbitalPositions(
  skills: Skill[],
  tools: Tool[],
  schedules: Schedule[],
  channelCreds: CredentialSummary[],
  apiCreds: CredentialSummary[],
  savedPositions?: Map<string, { x: number; y: number }>,
  webhooks: WebhookSubscription[] = []
) {
  const pos = (
    id: string,
    defaultX: number,
    defaultY: number
  ): OrbitalPosition =>
    savedPositions?.get(id) ?? { x: defaultX, y: defaultY };

  // ── Brain center ──
  const brainPos = pos("brain-0", -OFFSETS.brain.hw, -OFFSETS.brain.hh);

  // ── Inner ring: fixed pentagon slots ──
  const hubs: HubConfig[] = [
    { id: "skills-hub", type: "skills-hub", slot: 0, exists: skills.length > 0 },
    { id: "tools-hub", type: "tools-hub", slot: 1, exists: tools.length > 0 },
    { id: "schedule-hub", type: "schedule-hub", slot: 2, exists: schedules.length > 0 },
    { id: "integrations-hub", type: "integrations-hub", slot: 3, exists: channelCreds.length > 0 },
    { id: "connections-hub", type: "connections-hub", slot: 4, exists: apiCreds.length > 0 },
    { id: "webhooks-hub", type: "webhooks-hub", slot: 5, exists: webhooks.length > 0 },
  ];

  const hubPositions = new Map<string, OrbitalPosition>();

  for (const hub of hubs) {
    if (!hub.exists) continue;
    const angle = HUB_SLOT_ANGLE(hub.slot);
    hubPositions.set(
      hub.id,
      pos(
        hub.id,
        Math.cos(angle) * INNER_RADIUS - OFFSETS.hub.hw,
        Math.sin(angle) * INNER_RADIUS - OFFSETS.hub.hh
      )
    );
  }

  // ── Fan-out helper ──
  function computeFanPositions<T>(
    items: T[],
    hubId: string,
    getNodeId: (item: T, index: number) => string,
    offset: { hw: number; hh: number }
  ): Map<string, OrbitalPosition> {
    const positions = new Map<string, OrbitalPosition>();
    if (items.length === 0 || !hubPositions.has(hubId)) return positions;

    const hubPos = hubPositions.get(hubId)!;
    const hubCenterX = hubPos.x + OFFSETS.hub.hw;
    const hubCenterY = hubPos.y + OFFSETS.hub.hh;
    const hubAngle = Math.atan2(hubCenterY, hubCenterX);

    const fanRadius = computeFanRadius(items.length);
    const fanSpread = computeFanArc(items.length, fanRadius);

    items.forEach((item, i) => {
      const fanAngle =
        items.length === 1
          ? hubAngle
          : hubAngle - fanSpread / 2 + (fanSpread * i) / (items.length - 1);
      const nodeId = getNodeId(item, i);
      positions.set(
        nodeId,
        pos(
          nodeId,
          hubCenterX + Math.cos(fanAngle) * fanRadius - offset.hw,
          hubCenterY + Math.sin(fanAngle) * fanRadius - offset.hh
        )
      );
    });

    return positions;
  }

  // ── Skills fan from skills-hub ──
  const skillPositions = computeFanPositions(
    skills,
    "skills-hub",
    (skill) => `skill-${skill.id}`,
    OFFSETS.skill
  );

  // ── Tools fan from tools-hub ──
  const toolPositions = computeFanPositions(
    tools,
    "tools-hub",
    (tool) => `tool-${tool.id}`,
    OFFSETS.tool
  );

  // ── Schedules fan from schedule-hub ──
  const schedulePositions = computeFanPositions(
    schedules,
    "schedule-hub",
    (sched) => `schedule-${sched.id}`,
    OFFSETS.schedule
  );

  // ── Channel integrations fan from integrations-hub ──
  const channelPositions = computeFanPositions(
    channelCreds,
    "integrations-hub",
    (cred) => `integration-${cred.id}`,
    OFFSETS.integration
  );

  // ── API integrations fan from connections-hub ──
  const apiPositions = computeFanPositions(
    apiCreds,
    "connections-hub",
    (cred) => `integration-${cred.id}`,
    OFFSETS.integration
  );

  // ── Webhooks fan from webhooks-hub ──
  const webhookPositions = computeFanPositions(
    webhooks,
    "webhooks-hub",
    (wh) => `webhook-${wh.id}`,
    OFFSETS.webhook
  );

  return {
    brainPos,
    hubPositions,
    skillPositions,
    toolPositions,
    schedulePositions,
    channelPositions,
    apiPositions,
    webhookPositions,
  };
}
