# Trajectory query API

A04 exposes persisted canonical trajectories as an authenticated, read-only API. It does not
provide mutation, replay, evaluation, or UI behavior.

## Authorization

Browser sessions retain full access. API keys require the dedicated `trajectory:read` scope;
generic `api:read` keys cannot read execution history.

## List trajectories

`GET /api/trajectories`

Results are ordered by `startedAt` descending and then trajectory ID descending. Pagination uses
an opaque, versioned keyset cursor rather than an offset, so equal timestamps have deterministic
ordering.

| Query parameter | Meaning                                               |
| --------------- | ----------------------------------------------------- |
| `limit`         | Page size from 1 to 100; defaults to 25.              |
| `cursor`        | Opaque `nextCursor` returned by the previous page.    |
| `sessionId`     | Exact `origin.sessionId` match.                       |
| `channelType`   | Exact `origin.channelType` match.                     |
| `channelId`     | Exact `origin.channelId` match.                       |
| `scheduleId`    | Exact `origin.scheduleId` match.                      |
| `origin`        | Exact canonical origin kind.                          |
| `status`        | Exact canonical trajectory status.                    |
| `model`         | Exact model ID or provider ID used by the trajectory. |
| `tool`          | Exact tool name used by a tool step.                  |
| `startedAfter`  | Inclusive ISO timestamp lower bound.                  |
| `startedBefore` | Exclusive ISO timestamp upper bound.                  |

The response is `{ data: { records, nextCursor } }`. List records contain metadata, model usage,
step/artifact counts, and bounded input/output previews.

## Inspect a trajectory

`GET /api/trajectories/:id`

The response is `{ data: { trajectory } }` and includes ordered steps and artifact references. A
missing trajectory returns `404`.

## Payload safety

All response payloads pass through the trajectory sensitive-key filter again. List payloads are
limited to 2 KiB and detail payloads to 16 KiB per input, output, attribute, or tool-argument body.
Larger values are represented as `{ preview, truncated: true, originalBytes }`; artifact metadata
remains a reference and does not inline artifact bodies.

Malformed cursors, invalid enum values, invalid time ranges, and invalid limits return `400`.
