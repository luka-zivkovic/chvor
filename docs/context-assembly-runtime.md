# Context assembly runtime (B12)

B12 is the server-side runtime that turns already-authorized context candidates
into one bounded, deterministic model-input fragment. The selection core is pure:
it receives a typed candidate list, fixed configuration, and a tokenizer, and it
returns the assembly, rendered prompt, content-free trace, and exclusion
diagnostics without reading storage, calling a model, or mutating memory.

The orchestrator owns candidate collection and supplies the assembly ID and
timestamp. Given byte-equivalent inputs, the core produces byte-equivalent output.

## Turn integration

For each conversational turn, `apps/server/src/lib/orchestrator.ts` builds the
candidate pool from these sources:

1. **Stable blocks.** Interactive requests read current `identity`, `human`, and
   `procedural` snapshots directly with `listMemoryBlocksForAssembly()`. This is a
   bounded canonical read, not similarity retrieval. Store order is layer,
   `declaredOrder`, then opaque block ID; the assembler independently applies its
   canonical ordering again.
2. **Working state.** An existing rolling session summary, when supplied, and all
   messages chronologically before the current request become `working`
   candidates. Timestamp ties use unsigned UTF-8 byte order of message IDs. The
   current request remains in its native user message outside the six-layer
   hierarchy, and messages after it are not candidates.
3. **Graph memory.** Retrieved, graph-associated, and predictively preloaded
   memories become `episodic` or `knowledge` candidates. Only the stored L0
   `abstract` is exposed as the full candidate representation; L1 `overview`, L2
   `detail`, compatibility content, and other memory metadata are not copied into
   model content.

Graph rows map to `knowledge` when `sourceResourceId` is non-null,
`provenance === "resource"`, or `sourceChannel === "knowledge"`; all other rows
map to `episodic`. This is a read-time projection and does not migrate or rewrite
the graph.

Persistent sources are enabled by default for interactive requests. Stable blocks
and graph-memory candidates are intentionally omitted when `channelType` is
`scheduler`, `pulse`, `webhook`, or `daemon`. Working history can still be adapted
from the messages supplied to the turn. Stable-block read or validation failure
fails the turn closed; the orchestrator never silently continues without identity
or human constraints.

Candidate producers are independently bounded to 1,000 stable blocks, 500 working
items (including a rolling summary), and 30 graph rows. The shared aggregate input
boundary is 2,000 items. A stable store with more than 1,000 current rows is detected
with a SQLite-side sentinel count and fails closed instead of silently omitting later
rows. SQLite also sums the selected snapshot bytes before materializing them; more
than 64 MiB of stable snapshots fails closed to protect the server heap.

## Canonical ordering

The shared runtime in `packages/shared/src/lib/context-assembly.ts` validates strict
v1 candidates, normalizes retrieval scores to six decimal places in the server
configuration, and orders the six layers as:

1. `identity`
2. `human`
3. `working`
4. `procedural`
5. `episodic`
6. `knowledge`

Within a layer, ordering is deterministic:

| Layer                   | Runtime order                                                                     |
| ----------------------- | --------------------------------------------------------------------------------- |
| `identity`, `human`     | `declaredOrder` ascending                                                         |
| `working`               | `turnIndex` descending, unresolved before completed, event time descending        |
| `procedural`            | required before optional, scope specificity descending, `declaredOrder` ascending |
| `episodic`, `knowledge` | non-null retrieval score descending, event time descending                        |

Every tie ends with the NFC-normalized canonical reference tuple
`(namespace, id, revision)` compared as unsigned UTF-8 bytes. Inclusion reasons
are also normalized and sorted. The candidate's input position therefore does not
affect the output.

The core does not perform retrieval, authorization, lifecycle filtering, or claim
conflict resolution. Candidate producers must complete those decisions before
assembly. The core validates the typed boundary, orders candidates, rejects a
second occurrence of the same canonical reference, and applies budgets.

## Window reservation and layer budgets

The orchestrator assembles once against the active fallback profile with the least
usable prompt headroom (`context window - response reserve`). This accounts for a
larger-window fallback that reserves more response tokens than a smaller model.

Before allocating hierarchy capacity, it reserves space for:

- system instructions;
- developer instructions (currently recorded as zero by this adapter);
- the current request, including the media-token estimate;
- provider-facing JSON Schema tool definitions;
- the context renderer preamble and six layer headings; and
- the model's response-token reserve.

If those outside-hierarchy inputs exceed the selected least-headroom profile, assembly fails with
`ContextWindowOverflowError`; it does not squeeze them into a context layer.

The remaining hierarchy budget receives these base shares:

| Layer        |                     Base allocation |
| ------------ | ----------------------------------: |
| `identity`   |                                 20% |
| `human`      |                                 20% |
| `working`    |                                 25% |
| `procedural` |                                 15% |
| `episodic`   |                                 10% |
| `knowledge`  | 10% plus integer-rounding remainder |

The first five shares use integer floor division and `knowledge` receives the exact
remainder, so the complete hierarchy budget is allocated. After each layer is
processed, unused capacity flows forward to the next layer. Capacity never flows
backward, and a later layer cannot evict an item already selected from an earlier
layer.

For each candidate, the assembler counts the complete JSON line that would be
rendered, including provenance metadata and the trailing newline. It tries the one
required `full` representation first. If full does not fit, it tries only approved
`compact` representations that are no larger than full, largest fitting form
first, with representation ID and version as deterministic tie-breakers. It never
clips an excerpt or asks a model to summarize. If no approved form fits, the shared
assembler records an exclusion and continues with the next canonical candidate.
The server adapter then fails closed if any identity or human exclusion is marked
critical, as described below.

The current stable-block, working-history, rolling-summary, and graph-memory
adapters publish full representations only. Compact-form selection is implemented
for candidate producers that explicitly provide deterministic, versioned compact
forms; B12 does not generate them opportunistically.

## Conservative tokenizer profile

Until provider-native tokenizers are registered, B12 uses the versioned
`chvor:utf8-byte-upper-bound:<provider>/<model>` profile, version `1`. It charges
one token per UTF-8 byte. This deliberately conservative provider-independent
upper bound avoids granting capacity based on an optimistic estimate. The profile
identity is tied to the least-headroom fallback model and is recorded in the
assembly and trace.

The renderer also verifies that the tokenizer is safely additive across the
pre-counted segments. A mismatch fails assembly instead of silently exceeding the
window.

Tool accounting projects AI SDK definitions to the provider-facing JSON Schemas,
rather than serializing Zod internals. Immediately before every model attempt,
including later tool rounds and fallback attempts, the runtime rechecks the complete
message and tool payload with fixed base, per-message, and per-tool protocol framing
margins. Growth beyond the selected window raises `ContextWindowOverflowError`.

## Typed prompt boundary

The rendered fragment starts with a data-boundary preamble, then emits all six
layer headings in canonical order. Each selected item is one JSON value containing
only:

- owner, mutability, and authority;
- canonical reference and source reference;
- selected representation kind, ID, and version; and
- bounded JSON `content`.

Strings, arrays, and objects remain JSON-encoded rather than being interpolated
into an instruction template. The preamble explicitly identifies these values as
bounded context data, not system or developer instructions. The validated runtime
assembly retains additional visibility, ordering, reason, and token-accounting
metadata that is not duplicated into each rendered JSON line.

The fragment is sent as a dedicated user-role data message immediately before the
native current request. It is not appended to a system message, so untrusted working
or graph content cannot gain provider-level system authority. Stable system prompts
contain only static instructions; context bodies remain in the typed data envelope.

## Trace and exclusion diagnostics

After assembly, the orchestrator records one completed `context.assembled`
trajectory step. Its `contextAssembly` field contains the validated content-free
projection: configuration, layer policies, opaque references, inclusion reasons,
selected representation metadata, canonical ordering, and token accounting remain;
every item `content` field is removed. The dedicated B12 form rejects generic
`input` or `output`, requires empty `attributes`, and rejects extension payload
fields, preventing a second path for context bodies. Schema-v1 readers retain only
read compatibility for generic B10-era rows; the B12 runtime never emits that form.

Exclusions are returned separately from the persisted trace. Each diagnostic
contains the layer and canonical reference, rank within that layer's candidate
list, reason, minimum required tokens, available tokens, and a `critical` flag.
Identity and human exclusions are critical. The shared pure assembler still
returns the complete result and diagnostics so callers can inspect deterministic
selection behavior.

`assembleTurnContext()` is the server's fail-closed boundary. After the shared
assembly returns, it gathers all critical diagnostics and throws
`ContextStableOverflowError`, a `ContextWindowOverflowError` subtype, instead of
returning a prompt that omitted stable identity or human context. The error message
contains only comma-separated canonical opaque references in
`namespace:id@revision` form; it does not include candidate content, labels, or
excerpts. The orchestrator therefore does not append the prompt or record a
successful `context.assembled` step for that failed assembly.

The reason registry is
`layer-budget`, `no-approved-form`, and `duplicate-reference`; with the current
candidate schema's required full form, ordinary size pressure is reported as
`layer-budget`. Exclusion diagnostics are currently available to runtime callers
and tests but are not added to the `context.assembled` trajectory step or exposed
through a dedicated API.

## Non-goals and current limitations

- B12 has no context or memory inspector UI. B13 remains responsible for that
  product surface.
- B12 does not autonomously delegate persistent context to background scheduler,
  pulse, webhook, or daemon executions. Those channel types exclude stable blocks
  and graph memory by default.
- B12 does not create opportunistic rolling summaries or compact forms. It can use
  an existing session summary supplied by the gateway and predeclared compact
  representations supplied by a candidate producer.
- The pure assembler does not retrieve data, mutate memory, resolve authorization,
  adjudicate conflicting claims, or enforce the server's stable-overflow failure.
  Those remain adapter or upstream responsibilities.
- Stable block, working, and graph adapters currently expose text content as JSON
  strings. The contract supports other bounded JSON values, but these adapters do
  not produce them today.
- Historical media bytes are not replayed by the B12 working adapter. Its text is
  preserved, but a later media-replay policy requires a separately bounded native
  multimodal path.

## Implementation map

| File                                                          | Responsibility                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/shared/src/types/context.ts`                        | v1 assembly and content-free trace contracts                                          |
| `packages/shared/src/types/context-assembly.ts`               | candidate, tokenizer, cap, and exclusion schemas                                      |
| `packages/shared/src/lib/context-assembly.ts`                 | pure ordering, selection, rendering, and trace projection                             |
| `apps/server/src/lib/orchestrator/context-tokenizer.ts`       | versioned UTF-8-byte upper-bound profile                                              |
| `apps/server/src/lib/orchestrator/context-assembler.ts`       | outside-hierarchy reservation, base layer allocation, and fail-closed stable overflow |
| `apps/server/src/lib/orchestrator/context-block-adapter.ts`   | stable block candidates                                                               |
| `apps/server/src/lib/orchestrator/context-working-adapter.ts` | rolling summary and historical message candidates                                     |
| `apps/server/src/lib/orchestrator/context-memory-adapter.ts`  | graph L0 candidates and episodic/knowledge projection                                 |
| `apps/server/src/lib/orchestrator/trajectory-adapter.ts`      | `context.assembled` capture                                                           |

See [`CONTEXT.md`](CONTEXT.md) for the hierarchy contract,
[`MEMORY.md`](MEMORY.md) for the two persistence models, and
[`trajectory-api.md`](trajectory-api.md) for query behavior.
