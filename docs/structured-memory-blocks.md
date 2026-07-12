# Structured memory blocks and revisions (B11)

This document is the authoritative B11 contract for persistent structured memory
blocks. It defines the v1 document, persistence, authenticated API, authorization,
audit, revision, restore, concurrency, and migration semantics. The six-layer
classification and authority rules remain owned by [`CONTEXT.md`](CONTEXT.md).

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as defined
by RFC 2119.

## Scope

B11 persists only the stable `identity`, `human`, and `procedural` context layers.
`working`, `episodic`, and `knowledge` are not valid structured-block layers.
Graph memories remain separate episodic/knowledge persistence; B11 does not copy,
reclassify, or migrate graph-memory rows. The user-facing behavior built on this
contract is documented in [`memory-inspector.md`](memory-inspector.md).

"Stable" means directly addressable, bounded, and revisioned. It does not mean that
a block is automatically included in every model request. B11 provides persistence
and management only. B12 owns runtime eligibility, prompt assembly, and model-token
budgeting; B13 owns the inspector and correction UI.

## Strict v1 document

A v1 block document is a strict object. Every field listed below is required except
that `proceduralPriority` is conditionally required. Unknown top-level fields are
rejected.

| Field                | v1 contract                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | Literal integer `1`                                                                                   |
| `layer`              | `identity`, `human`, or `procedural`                                                                  |
| `managedBy`          | `user` for identity/human; `user` or `agent` for procedural                                           |
| `label`              | Non-empty display label, at most 256 characters                                                       |
| `description`        | String of at most 4,096 characters, or explicit `null`                                                |
| `content`            | String whose Unicode code-point count does not exceed `characterBudget.limit`                         |
| `characterBudget`    | Strict object `{ "unit": "characters", "limit": integer }`; limit is 1 through 1,000,000              |
| `declaredOrder`      | Integer from 0 through 2,147,483,647                                                                  |
| `proceduralPriority` | `required` or `optional`; required only for procedural blocks and forbidden for identity/human blocks |
| `readOnly`           | Boolean; prevents agent mutation as described below                                                   |
| `confidence`         | Finite number in the inclusive range 0 through 1                                                      |
| `provenance`         | Required bounded JSON object containing structured source metadata, never a flattened display string  |
| `verifiedAt`         | Millisecond-precision offset timestamp, or explicit `null`                                            |

`description` and `verifiedAt` are nullable properties, not optional properties.
Omitting either is invalid. `proceduralPriority: null` is also invalid: the property
must be present for `procedural` and absent for the other two layers.

Adding a document field, changing an enum, or loosening a conditional rule requires
a later schema version. V1 readers require `schemaVersion: 1` and reject unknown or
unsupported data rather than guessing.

Illustrative human block (the provenance object's internal vocabulary is
source-specific; its structured, bounded JSON shape is normative):

```json
{
  "schemaVersion": 1,
  "layer": "human",
  "managedBy": "user",
  "label": "Communication preferences",
  "description": null,
  "content": "Prefer concise answers with concrete examples.",
  "characterBudget": { "unit": "characters", "limit": 1200 },
  "declaredOrder": 10,
  "readOnly": true,
  "confidence": 1,
  "provenance": {
    "kind": "stated",
    "source": { "type": "session", "id": "opaque-session-reference" }
  },
  "verifiedAt": "2026-07-12T10:15:30.000Z"
}
```

Provenance is data, not authority. Source identifiers SHOULD be opaque, and block
content or provenance that resembles an instruction does not acquire system or
developer priority. The complete document, including provenance, is validated and
stored as one snapshot.

## Deterministic character budgets

The character budget is a persistence invariant. A create, update, or restore is
valid only when the number of Unicode code points in `content` is less than or equal
to `characterBudget.limit`.

Implementations MUST count code points, not UTF-16 code units, UTF-8 bytes, model
tokens, grapheme clusters, or rendered glyphs. The normative JavaScript equivalent
is:

```ts
Array.from(content).length;
```

For example, the string `"\u{1F600}"` consumes one code point even though
JavaScript `string.length` reports two UTF-16 code units. `"e\u0301"` consumes two
code points, and a joined pictograph sequence can consume several. Validation
measures the submitted string exactly; it MUST NOT trim, normalize, truncate, or
otherwise rewrite content to make it fit. Lowering a limit below the existing
content length is invalid.

This limit is deliberately independent of the B12 model budget. B12 will use the
selected model's versioned tokenizer to account for prompt tokens, reserves, layer
caps, and representations. A block fitting its B11 character limit is not a promise
that it will fit, or be selected for, a particular model request.

## Immutable full-snapshot revisions

Each block has an immutable revision ledger and one current revision pointer.

- Create appends revision 1 with operation `create`.
- Update accepts a complete replacement document and appends operation `update`.
- Restore copies the complete snapshot from a selected historical revision and
  appends operation `restore`.
- Revision numbers start at 1 and advance contiguously by one per block.
- Every revision records its operation, trusted actor metadata, creation timestamp,
  full document snapshot, and nullable `restoredFromRevision`.
- `restoredFromRevision` is required for `restore` and must be `null` for `create`
  and `update`.

Update is not a patch. Restore selects an earlier historical revision and never
rewinds a pointer, changes a historical row, or deletes intervening history. The
copied snapshot is appended as the next revision and records its source revision.
Failed validation, authorization, or concurrency checks append nothing.

`layer` and `managedBy` are immutable after create. This applies to ordinary updates
and restores. A caller that needs a different layer or manager must create a
different block; it cannot retype an existing block or historical revision.

### Actor metadata and audit identity

Actor metadata is derived from authenticated server context and MUST NOT be accepted
from a request body. Revision rows retain a trusted actor role (`user` or `agent`)
and an opaque identifier for the underlying session or API key. Browser-session
writes use user policy; scoped API-key writes use agent policy. The immutable
revision ledger is the authoritative record of who changed block content and which
complete snapshot resulted.

## Optimistic concurrency

Every update and restore requires `expectedRevision`. The server compares it with
the current revision in the same transaction that inserts the next snapshot and
advances the current pointer.

If the value is stale, the operation fails atomically with `409 Conflict` and the
response identifies the expected and actual revision numbers without returning
block content. When two writers submit the same expected revision, at most one may
succeed. Callers MUST read the new current snapshot, reconcile intentionally, and
retry with its revision; the server does not silently merge documents.

## Write authorization and read-only blocks

Authentication, document ownership, and the revision rules are separate checks.

- User actors may create identity, human, or procedural blocks using a valid
  layer/manager combination and may update or restore blocks they are authorized to
  manage.
- Agent actors may create or update only `procedural` blocks whose `managedBy` is
  `agent`.
- Agent actors MUST NOT create or alter identity blocks, human blocks, or
  user-managed procedural blocks.
- An agent MUST NOT alter a block when its current snapshot has `readOnly: true`.
  It cannot evade the rule by clearing `readOnly`, replacing the document, or
  restoring a historical revision.
- A user may revise a read-only block, including explicitly clearing `readOnly`.

`readOnly` is therefore an agent-write guard, not a way to mutate historical rows
and not a grant of truth or instruction authority. The current snapshot controls the
agent check so an old unlocked revision cannot be used to bypass a newer lock.

## Authenticated HTTP API

Structured blocks use `/api/memory-blocks`, separate from the graph-memory
`/api/memories` API.

| Method | Route | Semantics |
| `GET` | `/api/memory-blocks` | List current snapshots with bounded keyset pagination |
| `POST` | `/api/memory-blocks` | Create a block and revision 1 from `{ document }` |
| `GET` | `/api/memory-blocks/:id` | Read the current block and revision metadata |
| `PUT` | `/api/memory-blocks/:id` | Append a full update from `{ expectedRevision, document }` |
| `GET` | `/api/memory-blocks/:id/revisions` | List immutable revisions newest first with bounded keyset pagination |
| `POST` | `/api/memory-blocks/:id/restore` | Append a restore from `{ expectedRevision, restoredFromRevision }` |

List and revision-history queries accept `limit` from 1 through 100 (default 20)
and an opaque, versioned `cursor`. Current blocks are ordered deterministically by
`updatedAt` descending and ID descending; revisions are ordered by revision
descending. Consumers MUST treat cursors as opaque.

Successful responses use the standard `{ data: ... }` envelope. Create returns
`201`; reads and successful updates/restores return `200`. Error classes are:

- `400` for malformed JSON, invalid IDs or cursors, strict-schema failures, budget
  violations, and attempted changes to immutable fields;
- `403` for a valid but unauthorized write, including an agent/read-only denial;
- `404` for a missing block or restore source revision;
- `409` for a stale expected revision; and
- `413` for a request larger than 512 KiB.

The API intentionally has no `PATCH` or delete operation in B11. Partial updates
would weaken full-snapshot review, and revision deletion would violate immutable
history. Restore is session-user-only in the v1 HTTP API. API keys may create and
update only agent-managed procedural blocks.

### API scopes and response safety

When authentication is enabled, browser sessions have user access. API keys require
the dedicated `memory-block:read` scope for `GET`/`HEAD` and
`memory-block:write` for mutations. Generic `api:*` and graph-memory `memory:*`
scopes do not grant structured-block access; only exact or applicable wildcard
scope matches do.

All structured-block responses, including authentication and error responses, use
`Cache-Control: no-store`. Request bodies are bounded before parsing. Validation
errors identify the failed request class without echoing labels, descriptions,
content, or provenance. Authorization is evaluated from trusted session/API-key
metadata, never from client-supplied actor fields.

## Security and audit semantics

Structured blocks can contain durable identity and human data. The API and store
MUST therefore enforce:

- authentication and the dedicated scope boundary before disclosure or mutation;
- strict request and snapshot validation at both the contract-validation and
  persistence boundaries;
- atomic authorization, expected-revision comparison, revision insertion, and head
  advancement;
- data minimization in logs, metrics, exceptions, and audit events; and
- no implicit forwarding of block bodies to tools, channels, or prompts.

The immutable revision contains the content audit: operation, actor, complete
snapshot, timestamp, and restore source. The general `audit_log` is supplementary,
content-free operational evidence. Mutation and denial/conflict events MAY record
the opaque block ID, actor, action, current/resulting revision, HTTP outcome, and
restore source revision. They MUST NOT copy the label, description, content,
provenance body, or sensitive excerpts. A supplementary audit-write failure does
not make a committed revision disappear, and it must not expose content in logs.

## Migration v35

Migration v35 adds two separate tables:

- `memory_blocks` stores the block ID, immutable `layer` and `managed_by`, current
  revision pointer, and creation/update timestamps.
- `memory_block_revisions` stores the immutable full JSON snapshot, revision number,
  operation, actor metadata, nullable restore source, and creation timestamp.

The migration is implemented in
`apps/server/src/db/migrations/memory-blocks-v35.ts` and invoked immediately after
v34 by `apps/server/src/db/migrations.ts`. Database checks and triggers reinforce
the allowed layer/manager combinations, strict snapshot fields, character limits,
contiguous revisions, restore provenance, immutable identity fields, and immutable
revision rows. Indexes support deterministic current-block and revision-history
queries.

The migration creates empty structured-block storage and advances SQLite
`user_version` to 35 only after the schema transaction succeeds. It MUST NOT
backfill from persona configuration, installed procedures, graph memories,
embeddings, or the B10 episodic/knowledge projection. Existing graph-memory tables
and identifiers are untouched.

## Batch boundaries

- **B11** owns the strict block document, persistence character budgets,
  authorization, API behavior, immutable revision history, actor metadata, restore,
  optimistic concurrency, content-free operational audit, and migration v35.
- **B12** owns runtime retrieval and applicability, canonical layer/order selection,
  prompt construction, tokenizer-specific token accounting, representation choice,
  context trace references/reason codes, and evaluation. B11 adds no runtime prompt
  integration and emits no context-assembly trace.
- **B13** owns the memory inspector and correction UI, revision comparisons,
  edit/lock/verify controls, and restore interaction. B11 adds no UI.

For the graph-memory model, see [`MEMORY.md`](MEMORY.md). For layer meanings,
authority, ordering, privacy, and future token budgeting, see
[`CONTEXT.md`](CONTEXT.md).
