import { Hono } from "hono";
import type { TrajectoryOrigin, TrajectoryStatus } from "@chvor/shared";
import { getTrajectory } from "../db/trajectory-store.ts";
import { listTrajectories, type TrajectoryListQuery } from "../db/trajectory-query-store.ts";
import {
  decodeTrajectoryCursor,
  encodeTrajectoryCursor,
  trajectoryDetail,
  trajectoryListItem,
  TrajectoryQueryError,
} from "../lib/trajectory-query-api.ts";
import {
  compareTrajectoryTimestamps,
  isCanonicalTrajectoryTimestamp,
} from "../lib/trajectory-time.ts";

const trajectories = new Hono();
const MAX_LIMIT = 100;
const STATUSES: readonly TrajectoryStatus[] = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "aborted",
  "round-limited",
];
const ORIGINS: readonly TrajectoryOrigin["kind"][] = [
  "web-chat",
  "channel",
  "schedule",
  "webhook",
  "daemon",
  "cognitive-loop",
  "api",
  "system",
  "test",
];

trajectories.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

function boundedText(value: string | undefined, name: string, max = 512): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new TrajectoryQueryError(`${name} must contain 1-${max} characters`);
  }
  return trimmed;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 25;
  if (!/^\d+$/.test(value)) throw new TrajectoryQueryError("limit must be an integer");
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new TrajectoryQueryError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function parseTime(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isCanonicalTrajectoryTimestamp(value)) {
    throw new TrajectoryQueryError(`${name} must be an ISO date`);
  }
  return value;
}

function parseListQuery(query: (name: string) => string | undefined): TrajectoryListQuery {
  const status = boundedText(query("status"), "status", 32);
  if (status && !STATUSES.includes(status as TrajectoryStatus)) {
    throw new TrajectoryQueryError(`status must be one of: ${STATUSES.join(", ")}`);
  }
  const origin = boundedText(query("origin"), "origin", 32);
  if (origin && !ORIGINS.includes(origin as TrajectoryOrigin["kind"])) {
    throw new TrajectoryQueryError(`origin must be one of: ${ORIGINS.join(", ")}`);
  }
  const startedAfter = parseTime(query("startedAfter"), "startedAfter");
  const startedBefore = parseTime(query("startedBefore"), "startedBefore");
  if (
    startedAfter &&
    startedBefore &&
    compareTrajectoryTimestamps(startedAfter, startedBefore) >= 0
  ) {
    throw new TrajectoryQueryError("startedAfter must be earlier than startedBefore");
  }
  const cursor = query("cursor");
  return {
    limit: parseLimit(query("limit")),
    ...(cursor === undefined ? {} : { cursor: decodeTrajectoryCursor(cursor) }),
    sessionId: boundedText(query("sessionId"), "sessionId"),
    channelType: boundedText(query("channelType"), "channelType", 64),
    channelId: boundedText(query("channelId"), "channelId"),
    scheduleId: boundedText(query("scheduleId"), "scheduleId"),
    status: status as TrajectoryStatus | undefined,
    origin: origin as TrajectoryOrigin["kind"] | undefined,
    model: boundedText(query("model"), "model", 256),
    tool: boundedText(query("tool"), "tool", 256),
    startedAfter,
    startedBefore,
  };
}

trajectories.get("/", (c) => {
  try {
    const result = listTrajectories(parseListQuery((name) => c.req.query(name)));
    return c.json({
      data: {
        records: result.records.map(trajectoryListItem),
        nextCursor: result.nextCursor ? encodeTrajectoryCursor(result.nextCursor) : null,
      },
    });
  } catch (error) {
    if (error instanceof TrajectoryQueryError) {
      return c.json({ error: "Invalid trajectory query", detail: error.message }, 400);
    }
    throw error;
  }
});

trajectories.get("/:id", (c) => {
  const id = c.req.param("id");
  if (id.length === 0 || id.length > 512) {
    return c.json({ error: "Invalid trajectory ID" }, 400);
  }
  const record = getTrajectory(id);
  if (!record) return c.json({ error: "Trajectory not found" }, 404);
  return c.json({ data: { trajectory: trajectoryDetail(record) } });
});

export default trajectories;
