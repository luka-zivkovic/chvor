import type { CanonicalTrajectoryV1 } from "@chvor/shared";
import type { TrajectoryListCursor, TrajectoryListRecord } from "../db/trajectory-query-store.ts";
import { sanitizeTrajectoryPayload } from "./orchestrator/trajectory-payload.ts";
import { isCanonicalTrajectoryTimestamp } from "./trajectory-time.ts";

export const TRAJECTORY_LIST_PAYLOAD_BYTES = 2 * 1024;
export const TRAJECTORY_DETAIL_PAYLOAD_BYTES = 16 * 1024;

export class TrajectoryQueryError extends Error {}

export interface BoundedPayloadPreview {
  preview: string;
  truncated: true;
  originalBytes: number;
}

function serialized(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function sanitizedObject(value: unknown): Record<string, unknown> {
  const safe = sanitizeTrajectoryPayload(value);
  return typeof safe === "object" && safe !== null && !Array.isArray(safe) ? safe : {};
}

function utf8Preview(value: string, maxBytes: number): string {
  return Buffer.from(value).subarray(0, maxBytes).toString("utf8");
}

/** Defense-in-depth redaction plus a hard per-payload response bound. */
export function boundedTrajectoryPayload(
  value: unknown,
  maxBytes: number
): unknown | BoundedPayloadPreview {
  if (value === undefined) return undefined;
  const safe = sanitizeTrajectoryPayload(value);
  const json = serialized(safe);
  if (json === undefined) return { preview: "[UNSERIALIZABLE]", truncated: true, originalBytes: 0 };
  const bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) return safe;
  return {
    preview: utf8Preview(json, maxBytes),
    truncated: true,
    originalBytes: bytes,
  };
}

export function encodeTrajectoryCursor(cursor: TrajectoryListCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

export function decodeTrajectoryCursor(value: string): TrajectoryListCursor {
  if (value.length === 0 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TrajectoryQueryError("cursor is malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new TrajectoryQueryError("cursor is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TrajectoryQueryError("cursor is malformed");
  }
  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.join(",") !== "id,startedAt,v" ||
    candidate.v !== 1 ||
    !isCanonicalTrajectoryTimestamp(candidate.startedAt) ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.length > 512
  ) {
    throw new TrajectoryQueryError("cursor is malformed");
  }
  // Keep the validated representation verbatim. Date#toISOString truncates
  // valid fractional seconds beyond milliseconds and can create keyset gaps.
  return { startedAt: candidate.startedAt, id: candidate.id };
}

export function trajectoryListItem(record: TrajectoryListRecord): Record<string, unknown> {
  return {
    id: record.id,
    origin: record.origin,
    actor: record.actor,
    status: record.status,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    startedAt: record.startedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.input === undefined
      ? {}
      : { input: boundedTrajectoryPayload(record.input, TRAJECTORY_LIST_PAYLOAD_BYTES) }),
    ...(record.output === undefined
      ? {}
      : { output: boundedTrajectoryPayload(record.output, TRAJECTORY_LIST_PAYLOAD_BYTES) }),
    modelUsage: record.modelUsage,
    stepCount: record.stepCount,
    artifactCount: record.artifactCount,
  };
}

export function trajectoryDetail(trajectory: CanonicalTrajectoryV1): Record<string, unknown> {
  const { input, output, attributes, steps, artifacts, ...metadata } = trajectory;
  return {
    ...sanitizedObject(metadata),
    ...(input === undefined
      ? {}
      : { input: boundedTrajectoryPayload(input, TRAJECTORY_DETAIL_PAYLOAD_BYTES) }),
    ...(output === undefined
      ? {}
      : { output: boundedTrajectoryPayload(output, TRAJECTORY_DETAIL_PAYLOAD_BYTES) }),
    attributes: boundedTrajectoryPayload(attributes, TRAJECTORY_DETAIL_PAYLOAD_BYTES),
    artifacts: sanitizeTrajectoryPayload(artifacts),
    steps: steps.map((step) => {
      const {
        input: stepInput,
        output: stepOutput,
        toolCall,
        attributes: stepAttributes,
        artifacts: stepArtifacts,
        ...stepMetadata
      } = step;
      const toolRecord = toolCall as Record<string, unknown> | undefined;
      const args = toolRecord?.args;
      const toolMetadata = toolRecord
        ? Object.fromEntries(Object.entries(toolRecord).filter(([key]) => key !== "args"))
        : {};
      return {
        ...sanitizedObject(stepMetadata),
        ...(stepInput === undefined
          ? {}
          : { input: boundedTrajectoryPayload(stepInput, TRAJECTORY_DETAIL_PAYLOAD_BYTES) }),
        ...(stepOutput === undefined
          ? {}
          : { output: boundedTrajectoryPayload(stepOutput, TRAJECTORY_DETAIL_PAYLOAD_BYTES) }),
        ...(toolCall === undefined
          ? {}
          : {
              toolCall: {
                ...sanitizedObject(toolMetadata),
                args: boundedTrajectoryPayload(args, TRAJECTORY_DETAIL_PAYLOAD_BYTES),
              },
            }),
        artifacts: sanitizeTrajectoryPayload(stepArtifacts),
        attributes: boundedTrajectoryPayload(stepAttributes, TRAJECTORY_DETAIL_PAYLOAD_BYTES),
      };
    }),
  };
}
