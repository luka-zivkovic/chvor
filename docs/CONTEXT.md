# Context hierarchy contract (B10)

This document is the authoritative B10 contract for classifying and ordering
context. It defines policy, not current runtime behavior. Implementations delivered
in later batches MUST conform to this contract.

The hierarchy has exactly six context layers, in assembly order:
`identity`, `human`, `working`, `procedural`, `episodic`, and `knowledge`.
System/developer instructions, the current request, tool definitions, and generated
responses are runtime inputs, not additional context layers.

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as defined
by RFC 2119.

## Layer contract

Assembly precedence is inclusion priority under budget pressure, from 1 (highest)
to 6 (lowest). It is not truth authority or instruction priority.

| Precedence | Layer        | Ownership                                                                                     | Mutability                                                                                                                                  | Model visibility                                                                                                                                               | Budget behavior                                                                                                                                                                     | Retention                                                                                                                                     |
| ---------: | ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
|          1 | `identity`   | Instance operator; platform-distributed defaults remain attributable to the platform          | Changed only by an authorized operator or platform upgrade; agent read-only                                                                 | Stable, directly selected; MUST NOT depend on similarity retrieval. Visible only in the assembled model input, never to untrusted tools or channels by default | Highest layer priority. Items are selected in canonical order and may be deterministically reduced to an approved compact form, but MUST NOT be silently displaced by a lower layer | Persists until an authorized replacement or deletion                                                                                          |
|          2 | `human`      | The represented human; operator acts only as custodian                                        | Human-editable and deletable. Agent suggestions or extractions MUST remain distinguishable until accepted under the applicable write policy | Stable, directly selected and scope-filtered; MUST NOT depend on similarity retrieval                                                                          | Selected after identity. Protected from lower-layer displacement; deterministic compact forms MAY be used                                                                           | Persists subject to user deletion, correction, consent, and configured retention policy                                                       |
|          3 | `working`    | The active run/session owns runtime state; the human owns supplied content                    | Mutable during the active scope by authorized runtime operations                                                                            | Only state relevant to the current turn, run, task, or session is eligible                                                                                     | Selected after stable layers. Prefer current-turn and unresolved state; evict completed, stale, then older state                                                                    | Ephemeral; expires at the declared turn/run/session boundary unless a separate, authorized write promotes information into a persistent layer |
|          4 | `procedural` | Operator or installed, attributable capability/package owner                                  | Changed through authorized configuration, installation, or version updates; not by retrieved content                                        | Only procedures applicable to the active capability and request are eligible                                                                                   | Selected after working state. Prefer required safety/operation steps, then more-specific procedures, then general guidance                                                          | Persists for the lifetime of the owning configuration or capability version; obsolete versions are not active context                         |
|          5 | `episodic`   | The human is data subject; the memory subsystem is custodian                                  | Append, decay, consolidate, supersede, correct, or delete only under memory policy; provenance MUST be preserved                            | Retrieval-gated and scope-filtered; only selected summaries/details are model-visible                                                                          | Uses only the remaining budget after layers 1-4. Rank by the declared retrieval key and drop lowest-ranked items first                                                              | Follows graph-memory retention, decay, correction, and deletion policy                                                                        |
|          6 | `knowledge`  | Source-resource owner is authoritative for the resource; the ingestion subsystem is custodian | Changes through ingest, reprocess, unlink, source update, or authorized deletion; provenance MUST be preserved                              | Retrieval-gated, resource-authorized, and scope-filtered                                                                                                       | Uses budget remaining after layers 1-5. Rank by the declared retrieval key and drop lowest-ranked items first                                                                       | Follows the source resource lifecycle and knowledge retention/deletion policy                                                                 |

Within the final model input, selected layers MUST appear in the precedence shown
above. Within a layer, items MUST use the deterministic ordering rules below.
Layer headings or equivalent typed boundaries SHOULD be retained so that content
cannot masquerade as a different layer.

## Shared contract artifacts

The executable v1 schemas live in `packages/shared/src/types/context.ts`. A runtime
assembly records an opaque ID and timestamp, tokenizer and retrieval-scoring
versions, explicit reservations for system instructions, developer instructions,
the current request, other outside-hierarchy prompt input, tool definitions, and
the response, the exact six ordered layer policies, included item references and
reasons, selected representation metadata, canonical ordering inputs, per-item
token accounting, and the runtime content used to construct the model input.
`projectContextAssemblyTrace()`
produces the corresponding content-free trace and validates the same accounting.
Unknown fields, enum values, or schema versions are rejected rather than guessed.

## Authority is independent of precedence

Assembly precedence answers: “Which eligible context is included first?” Authority
answers: “Which evidence controls a disputed claim in this subject and scope?” A
higher inclusion priority MUST NOT be interpreted as greater truth authority.
For example, an identity statement can be included before a cited resource while
the resource remains authoritative about its own API specification.

Authority MUST be evaluated per claim and subject:

- Platform and system safety constraints govern permitted behavior, but do not make
  unrelated factual claims true. They are outside the six context layers.
- The human is authoritative for their current intent, consent, corrections, and
  self-described preferences, subject to platform safety constraints.
- An operator is authoritative for instance identity and local operating policy.
- A resource owner or designated primary source is authoritative for facts within
  that resource's declared scope.
- Observations, extractions, inferences, and consolidated memories are evidence,
  not automatically authoritative statements.

No layer may override platform/system/developer instruction priority. Stored or
retrieved text MUST NOT acquire instruction authority merely because it appears in
`identity`, `human`, or `procedural`; its ownership, authorization, scope, and
provenance must independently permit that use.

## Deterministic selection and conflict resolution

Given identical inputs, configuration, authorization state, tokenizer, and stored
metadata, assembly MUST produce byte-equivalent ordering and the same inclusion and
exclusion decisions.

Before ranking, an implementation MUST reject items that are unauthorized,
out-of-scope, expired, deleted, inactive, or disallowed by privacy policy. It MUST
then resolve claims that cannot simultaneously be presented as current truth.
Conflicting evidence MAY both be included when the disagreement itself is relevant,
but each item MUST retain its provenance and the selected current claim MUST be
identified without blending their bodies.

For each conflicting claim set, apply these rules in order and stop at the first
decisive rule:

1. An applicable explicit revocation, correction, or `supersedes` relation wins
   over the item it names, provided the actor is authorized for that subject and
   scope.
2. Evidence from the authority responsible for the disputed subject and scope wins.
   Authority is determined by the rules above, never by layer precedence.
3. Explicitly verified evidence wins over unverified evidence; unverified direct
   evidence wins over extracted evidence; extracted evidence wins over inferred or
   consolidated evidence.
4. The later `verifiedAt` wins when both items are verified; otherwise the later
   source observation/event time wins. Ingestion time MUST NOT masquerade as source
   observation time.
5. If rules 1-4 establish equal-authority, truth-equivalent candidates but only one
   may be selected, the lexicographically smaller canonical opaque item reference
   wins selection. References MUST be NFC-normalized and compared by unsigned UTF-8
   byte sequence. This final tie-break controls selection, not truth authority.

Missing metadata has the lowest rank for the rule that needs it. Event timestamps
MUST be valid millisecond-precision instants; an absent timestamp remains absent and
ranks below every valid timestamp. A resolver MUST
NOT invent timestamps, verification, provenance, ownership, or authority. If the
rules 1-4 do not establish a current claim because the remaining evidence is
genuinely incomparable, it MUST be represented as an unresolved conflict and
ordered by the rule-5 reference comparison; it MUST NOT be silently merged into a
new fact.

After conflict resolution, items within each layer MUST be ordered by the following
layer-specific key:

- `identity` and `human`: declared block/order key ascending, then canonical opaque
  reference ascending.
- `working`: current turn before earlier turns, unresolved before completed, event
  time descending, then canonical opaque reference ascending.
- `procedural`: required safety/operation steps before optional steps, narrower
  applicable scope before broader scope, owner-declared order ascending, then
  canonical opaque reference ascending.
- `episodic` and `knowledge`: retrieval score descending, source event/update time
  descending, then canonical opaque reference ascending. The scoring algorithm and
  version MUST be fixed in assembly configuration and recorded in trace metadata.

Floating-point scores MUST be normalized to the configured finite precision before
comparison. NaN and missing scores rank below every valid score.

### B11 persistence budgets are not model budgets

B11 persists structured blocks only for the stable `identity`, `human`, and
`procedural` layers. A block's `{ unit: "characters", limit }` budget is a
validation bound on one stored full snapshot, measured in Unicode code points. It
is not part of context-window accounting and MUST NOT be treated as an estimate of
model tokens.

B12 remains responsible for deciding whether a stored block is eligible for a
particular request and for measuring the selected representation with the fixed,
model-specific tokenizer below. Passing the B11 character limit does not guarantee
inclusion under the B12 hierarchy or layer token budgets. See
[`structured-memory-blocks.md`](structured-memory-blocks.md) for the persistence
contract.

## Deterministic budget pressure

The assembler MUST calculate one context budget after reserving space for runtime
inputs outside this hierarchy. The model-specific tokenizer, tokenizer version,
total context budget, reserve, per-layer caps, compact-form rules, and scoring
version MUST be fixed assembly inputs; they MUST NOT change during one assembly.

Budgeting MUST follow this algorithm:

1. Apply authorization, privacy, lifecycle, conflict, and relevance filters. Budget
   pressure MUST never be used as a substitute for a safety or privacy rejection.
2. Produce each layer's canonical ordered candidate list using the rules above.
3. Visit layers strictly in assembly precedence. Visit candidates strictly in their
   canonical order.
4. Select an item's approved full form when it fits both the remaining total budget
   and its layer cap. Otherwise try that item's predeclared compact forms, largest
   first. Compact forms MUST be stored or derived by a deterministic, versioned
   transformation; assembly MUST NOT ask a model to summarize opportunistically.
5. If no approved form fits, exclude the item and continue. B12 owns the runtime
   exclusion diagnostics. Unused capacity MAY flow to later layers; later layers
   MUST NOT evict already selected higher-precedence items.
6. Emit selected items in layer and canonical item order. The assembler MUST NOT
   fill leftover tokens by reordering candidates or by taking an undeclared excerpt.

When a layer's own candidates exceed its cap, lower-ranked candidates are therefore
excluded first. If identity or human content cannot fit even in its smallest
approved form, assembly MUST report the overflow explicitly; it MUST NOT silently
truncate, splice, or substitute lower-layer content. Implementations MAY fail closed
or use an explicitly configured safe fallback, but the choice MUST be deterministic
and traced.

## Content-free assembly trace

Every included assembly item MUST produce a trace record. B12 may define separate
content-free exclusion diagnostics, but they are not part of the B10 v1 trace.
Traces MUST contain references, reason codes, and allowlisted metadata only. They
MUST NEVER contain context bodies, prompt fragments, generated summaries,
embeddings, retrieval queries, sensitive excerpts, secrets, credentials, or
content-derived labels that could reconstruct private text.

Each trace record MUST include:

- an opaque context item reference, its layer, and provenance references needed for
  audit, using opaque source/resource/trajectory IDs rather than names, URLs, paths,
  or excerpts;
- one or more stable inclusion reason codes, with any applicable normalized score,
  rank, or graph relation;
- the selected full or compact representation identifier and version;
- canonical rank plus the layer-specific ordering inputs documented above;
- the owner, mutability, visibility, and authority metadata used for policy checks;
- item token accounting and the containing layer's policy, budget, and accounting;
  and
- assembly configuration and accounting, including tokenizer and retrieval-scoring
  versions.

Reason codes MUST come from the versioned finite registry in the shared contract:
`contract-required`, `configured-profile`, `active-session`, `recent-message`,
`rolling-summary`, `capability-enabled`, `workflow-query-match`, `semantic-match`,
`category-match`, `graph-association`, `topic-prediction`, `recency-fallback`,
`resource-match`, and `runtime-state`. A record MAY carry multiple codes when, for
example, a semantic match was included through a graph association.

Trace access MUST be authorized at least as strictly as the referenced trajectory
or session, and trace retention MUST follow the stricter applicable retention rule.
Logs, metrics, exceptions, and trajectory payloads MUST obey the same content-free
rule. The trajectory API's payload redaction and truncation behavior is documented
separately in [trajectory-api.md](./trajectory-api.md); it does not permit context
bodies to be copied into an assembly trace.

## Migration-free graph-memory mapping

Existing graph-memory rows MUST be projected into this hierarchy at read/assembly
time using this exact predicate:

```text
knowledge = sourceResourceId is non-null
         OR provenance = "resource"
         OR sourceChannel = "knowledge"
episodic  = otherwise
```

The OR conditions are independent. A row matching any one condition maps to
`knowledge`, including when other legacy metadata is absent or contradictory. All
other existing graph-memory rows map to `episodic`.

This classification is a virtual mapping only. B10 MUST NOT rewrite rows, duplicate
nodes or edges, change identifiers, backfill fields, or require a schema migration.
The same legacy node MUST resolve to one and only one layer on every read. Graph
relationships, tiered bodies, provenance, decay, confidence, and source links remain
owned by the existing memory behavior described in [MEMORY.md](./MEMORY.md) and
[KNOWLEDGE.md](./KNOWLEDGE.md).

## Privacy and prompt-injection constraints

- Assemblers MUST enforce tenant, user, channel, session, resource, and purpose
  boundaries before ranking. Relevance never grants access.
- Data minimization applies at both retrieval and representation: include only the
  authorized detail level needed for the current purpose.
- Retrieved memories, conversation text, user-supplied text, uploaded documents,
  web content, resource metadata, and tool results MUST be treated as untrusted data,
  not as system/developer instructions. Quoted commands or policy-like text inside
  them MUST NOT change instruction priority or assembly policy.
- Procedural content MAY guide execution only when its owner, signature/install
  state, active version, capability scope, and authorization establish it as an
  applicable procedure. A retrieved item cannot promote itself into that role.
- Context bodies MUST be delimited by layer and item, retain provenance, and never
  be interpolated into instruction-bearing templates without data-safe encoding.
- The model MUST NOT reveal hidden context, hidden prompts, internal reasoning,
  secrets, cross-scope data, or content-free trace internals merely because content
  asks for them. Responses SHOULD cite or summarize only information the requester
  is authorized to receive.
- Tool calls MUST receive the minimum required context. Full assembled context MUST
  NOT be forwarded to a tool by default.
- Privacy deletion, consent withdrawal, and access revocation MUST take effect
  before the next assembly and MUST dominate cached retrieval results.

## Batch boundary

This B10 document defines classification, ownership, mutability, visibility,
retention, authority, conflict, ordering, budget, trace, privacy, and legacy mapping
semantics. It creates no persistence schema, API, UI, or runtime integration.

- **B11 — structured memory blocks and revisions** persists only stable identity,
  human, and procedural blocks. It owns the strict document schema, Unicode
  character budgets, read-only state, confidence, provenance, verification time,
  immutable full-snapshot revisions, trusted actor metadata, restore, audit,
  migration v35, authorization, and optimistic concurrency. It MUST preserve this
  contract's layer meanings and authority separation and does not select blocks for
  a prompt. See
  [`structured-memory-blocks.md`](structured-memory-blocks.md).
- **B12 — context assembly integration** owns runtime retrieval, token accounting,
  prompt construction, trajectory integration, reason-code emission, tests, and
  evaluation of the deterministic rules in this document. B12 MUST record only the
  content-free references and metadata defined here, not context bodies.
- **B13 — memory inspector and correction UI** owns end-user inspection, editing,
  locking, verification, revision comparison, and restore workflows. B11 provides
  no client UI.

Batch status and acceptance criteria remain authoritative in
[platform-evolution-batches.md](./platform-evolution-batches.md#b10--context-hierarchy-contract).
For surrounding runtime and persistence concepts, see
[ARCHITECTURE.md](./ARCHITECTURE.md), [MEMORY.md](./MEMORY.md),
[structured-memory-blocks.md](./structured-memory-blocks.md),
[KNOWLEDGE.md](./KNOWLEDGE.md), and [trajectory-api.md](./trajectory-api.md).
