# Memory inspector and correction UI (B13)

The Memory panel exposes two deliberately separate kinds of persisted context:

- **Stable beliefs** are the revisioned `identity`, `human`, and `procedural`
  blocks defined by [`structured-memory-blocks.md`](structured-memory-blocks.md).
  They are the only records corrected by the B13 inspector.
- **Associative memory** is the existing graph-memory view. It remains useful for
  learned episodic and knowledge context, but it does not claim revision history,
  agent-write locks, verification, or append-only undo.

This boundary prevents a graph-memory edit from being presented as a safe,
revisioned belief correction.

## Inspector behavior

The stable-belief list and detail view show the stored source/provenance,
confidence, verification timestamp, current revision, layer, manager, agent-write
lock, and latest trusted actor category. Provenance describes where the belief
came from; the revision actor describes who last changed the stored snapshot. The
two are never treated as equivalent.

All mutations use the existing full-snapshot API:

- corrections send the complete document and current `expectedRevision`;
- **Prevent agent changes** toggles `readOnly` without implying that a session
  user cannot edit or unlock the block;
- **Verify now** changes only `verifiedAt`, using a millisecond UTC timestamp;
- restoring a historical revision appends a new `restore` revision; and
- **Undo last change** restores the immediately preceding revision, so undo is
  durable across reloads and never deletes audit history.

Changing belief content clears the prior verification timestamp unless the user
explicitly chooses to save and verify. Content is preserved exactly: the client
does not trim, normalize, or truncate it, and the shared schema counts Unicode
code points against the document character budget.

## Concurrency and safety

A `409 Conflict` is not retried or merged automatically. The inspector retains the
draft, refreshes the canonical head, and requires the user to reconcile and submit
again with the new revision. Other failures remain visible and never produce an
optimistic success state.

Block content and provenance are rendered as inert text, not HTML or executable
Markdown. Drafts and full snapshots remain panel-local and are not written to
local storage, telemetry, or generic logs. The client preflights mutation payloads
against the structured-memory HTTP request limit; the server remains the
authoritative validation and authorization boundary.

## Deliberate limits

B13 does not add graph-memory revision storage, shared multi-user memory, cloud
synchronization, block deletion, or a privacy-erasure workflow. The structured
block API remains append-only in v1, and the absence of deletion must not be
described as complete consent-withdrawal support.
