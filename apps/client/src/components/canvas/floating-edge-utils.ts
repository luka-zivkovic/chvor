import { Position, type InternalNode, type Node } from "@xyflow/react";

type Shape = "circle" | "rect";

interface AnchorConfig {
  shape: Shape;
  radius: number;
  orbOffsetY: number;
}

const ORB: Record<string, AnchorConfig> = {
  brain: { shape: "circle", radius: 90, orbOffsetY: 90 },
  skill: { shape: "circle", radius: 36, orbOffsetY: 36 },
  tool: { shape: "circle", radius: 36, orbOffsetY: 36 },
  integration: { shape: "circle", radius: 36, orbOffsetY: 36 },
  "skills-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "tools-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "integrations-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "connections-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "schedule-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "webhooks-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "ghost-hub": { shape: "circle", radius: 36, orbOffsetY: 36 },
  "a2ui-canvas": { shape: "circle", radius: 36, orbOffsetY: 36 },
  schedule: { shape: "circle", radius: 26, orbOffsetY: 26 },
  webhook: { shape: "circle", radius: 26, orbOffsetY: 26 },
  trigger: { shape: "circle", radius: 30, orbOffsetY: 30 },
  output: { shape: "circle", radius: 30, orbOffsetY: 30 },
};

function getAnchorConfig(node: InternalNode<Node>): AnchorConfig {
  const type = node.type ?? "";
  if (ORB[type]) return ORB[type];
  const w = node.measured?.width ?? 72;
  const h = node.measured?.height ?? 72;
  return { shape: "rect", radius: Math.min(w, h) / 2, orbOffsetY: h / 2 };
}

interface Anchor {
  cx: number;
  cy: number;
  config: AnchorConfig;
  width: number;
  height: number;
}

function getAnchor(node: InternalNode<Node>): Anchor {
  const config = getAnchorConfig(node);
  const pos = node.internals.positionAbsolute;
  const width = node.measured?.width ?? config.radius * 2;
  const height = node.measured?.height ?? config.radius * 2;
  return {
    cx: pos.x + width / 2,
    cy: pos.y + config.orbOffsetY,
    config,
    width,
    height,
  };
}

function cardinal(dx: number, dy: number): Position {
  return Math.abs(dx) > Math.abs(dy)
    ? dx > 0
      ? Position.Right
      : Position.Left
    : dy > 0
      ? Position.Bottom
      : Position.Top;
}

function circleIntersect(a: Anchor, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - a.cx;
  const dy = ty - a.cy;
  const dist = Math.hypot(dx, dy) || 1;
  return {
    x: a.cx + (dx / dist) * a.config.radius,
    y: a.cy + (dy / dist) * a.config.radius,
  };
}

function rectIntersect(a: Anchor, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - a.cx;
  const dy = ty - a.cy;
  const hw = a.width / 2;
  const hh = a.height / 2;
  if (dx === 0 && dy === 0) return { x: a.cx, y: a.cy };
  const scale = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: a.cx + dx * scale, y: a.cy + dy * scale };
}

function intersect(a: Anchor, tx: number, ty: number): { x: number; y: number } {
  return a.config.shape === "circle" ? circleIntersect(a, tx, ty) : rectIntersect(a, tx, ty);
}

export interface FloatingEdgeParams {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourcePosition: Position;
  targetPosition: Position;
}

export function getFloatingEdgeParams(
  source: InternalNode<Node>,
  target: InternalNode<Node>,
): FloatingEdgeParams {
  const s = getAnchor(source);
  const t = getAnchor(target);
  const sp = intersect(s, t.cx, t.cy);
  const tp = intersect(t, s.cx, s.cy);
  return {
    sx: sp.x,
    sy: sp.y,
    tx: tp.x,
    ty: tp.y,
    sourcePosition: cardinal(t.cx - s.cx, t.cy - s.cy),
    targetPosition: cardinal(s.cx - t.cx, s.cy - t.cy),
  };
}
