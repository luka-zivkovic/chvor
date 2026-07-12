# Trajectory query API

A04 exposes persisted canonical trajectories as an authenticated, read-only API. It does not
provide mutation, replay, evaluation, or UI behavior.

## Context inclusion traces

B12 records one completed `context.assembled` step after a successful server
assembly. The step's `contextAssembly` field is the validated, content-free
projection of the runtime assembly. It includes configuration and aggregate
accounting, all six layer policies and budgets, opaque item/source references,
inclusion reasons, selected representation metadata, canonical ordering inputs, and
per-item accounting. It never includes an item's `content` or a prompt fragment.

For the dedicated B12 form, the canonical step contract also rejects generic
`input` and `output`, requires empty `attributes`, and rejects extension payload
fields. This prevents context bodies from being attached through a secondary
trajectory field. Detail queries return this field with the rest of the ordered
steps, subject to the same trajectory authorization boundary.

The dedicated form is further restricted to the completed runtime shape: fixed
name, zero duration, no actor/model/tool/approval/error payloads, and no artifacts.

Schema-v1 readers remain compatible with generic `context.assembled` rows that may
have been persisted by a B10-era producer before the dedicated field existed. B12
never writes that legacy form. The stricter no-body rules apply whenever the
`contextAssembly` field is present, and every runtime B12 step includes it.

The shared pure assembler separately returns exclusion diagnostics with opaque
references and token counts. Those diagnostics are not persisted in the current
`context.assembled` step and have no dedicated query endpoint. At the server
boundary, any critical identity or human exclusion fails closed with
`ContextStableOverflowError`; its message includes only canonical opaque references,
not context bodies. Because assembly did not succeed, the orchestrator does not
record a successful `context.assembled` step for that attempt.

See [`CONTEXT.md`](CONTEXT.md) for the hierarchy and trace policy and
[`context-assembly-runtime.md`](context-assembly-runtime.md) for B12 runtime
behavior.

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

Detail responses also include `payloadTruncation: { input, output }`. This out-of-band marker lets
consumers distinguish an API-generated top-level preview from an ordinary user payload that happens
to contain preview-like field names.

`GET /api/trajectories/:id/evaluation-source` is an authenticated, `trajectory:read`-scoped escape
hatch for evaluation capture. It returns the complete redacted input on demand when the inspector
preview was truncated. The complete output is included only when the combined source remains within
the evaluation-document limit; otherwise `outputOmitted` is true. Oversized inputs return `413`.

Malformed cursors, invalid enum values, invalid time ranges, and invalid limits return `400`.
