# Evaluation case capture

A06 turns a redacted production trajectory into a local, versioned regression case. Capture is
available from the execution inspector; it does not execute the case or call a model.

## Portable document

Exports use schema version 1 and contain only deterministic test intent:

- a human-readable name;
- the selected input;
- an expected terminal status, expected output, and/or required output substrings;
- required and forbidden tool names; and
- selected safety assertions.

Trajectory, session, actor, tool-call, approval, artifact, and other transient identifiers are not
part of the portable schema. Captured transport timestamps and local database metadata are also
excluded. Object keys and set-like arrays are canonicalized so exporting an unchanged case produces
identical JSON.

## Redaction and validation

All imported, captured, and revised documents pass through the shared trajectory-safe JSON and text
redaction rules before persistence. Secret-shaped keys and credential-like text are redacted even if
a client bypasses the UI. Known transient identifier fields inside selected payloads are replaced by
`[TRANSIENT_ID]`; IDs, local media locators, and timestamps in known captured message, media, and
tool-action shapes use `[TRANSIENT_ID]` and `[TRANSIENT_TIMESTAMP]`. Domain-specific `id` and
`timestamp` fields outside those shapes remain usable as evaluation input. A case must define at
least one expected status, output value, or required output substring, and a tool cannot be both
required and forbidden.

Portable documents are limited to 512,000 UTF-8 bytes after normalization, and HTTP request bodies
have a slightly larger hard limit for the create/update envelope. The server rejects oversized data
before persistence. Output-substring assertions are entered one per line so commas remain literal.

The trajectory API marks top-level payload truncation out of band. The capture dialog never treats a
bounded preview envelope as real evaluation input or expected output. Instead, it retrieves the
complete redacted input through a protected, on-demand trajectory endpoint. A complete output is
loaded when it fits; otherwise it is omitted in favor of status or substring assertions.

## Local revisions

Each local case has a stable ID and monotonically increasing revision. Revisions are immutable;
updates require the caller's expected revision so concurrent edits fail instead of overwriting one
another. Importing a portable document creates a new local case at revision 1.

## API surface

`/api/evaluation-cases` provides authenticated list, create, inspect, revise, revision-history,
export, and import operations. API keys use dedicated evaluation read/write scopes. Browser sessions
retain full access.

Case lists and revision histories use bounded opaque-cursor pagination. Both accept `limit` and
`cursor`, return at most 20 complete records per page, and expose `nextCursor` when another page is
available. Malformed pagination inputs return `400`; unexpected storage failures remain server
errors and do not expose persistence details as validation feedback.

Export returns the portable document as canonical JSON. Import accepts that same document and stores
the sanitized result as a new local case.

## Non-goals

A06 does not run datasets, score outputs, invoke models, replay production side effects, or grade a
case. Those behaviors belong to A07.
