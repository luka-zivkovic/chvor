# Cognitive Memory System

Chvor has two complementary persistent memory forms. Graph memory is associative,
decaying, emotionally-aware, self-organizing, and retrieval-driven. Structured
memory blocks are bounded stable records with explicit metadata and immutable
revision history.

The graph remains the cognitive memory system described below. Structured blocks
provide a separate stable store. B12 now projects both stores into one
token-budgeted context assembly for interactive conversations; B13 owns the future
memory inspector and correction UI.

---

## How it works (the short version)

When you talk to Chvor, the system:

1. **Extracts** facts from the conversation (your name, projects, preferences)
2. **Stores** them as tiered memory nodes with strength, confidence, and category
3. **Links** related memories with typed edges (temporal, causal, entity, etc.)
4. **Retrieves** relevant memories using vector similarity + composite scoring and
   offers their L0 abstracts to the context assembler
5. **Strengthens** memories each time they're accessed (spaced repetition)
6. **Decays** unused memories over time (exponential forgetting curve)
7. **Consolidates** related fragments into coherent narratives during idle periods
8. **Predicts** which memories you'll need next based on topic transition patterns

The result: important, frequently-used facts stay vivid. Outdated or irrelevant
ones fade away. Related memories cluster together. The system learns what matters.

---

## Memory anatomy

Every memory is a **node** in a graph with three content tiers:

| Tier | Field      | Purpose                | Size        |
| ---- | ---------- | ---------------------- | ----------- |
| L0   | `abstract` | One-line summary       | ~120 chars  |
| L1   | `overview` | Paragraph with context | ~1000 chars |
| L2   | `detail`   | Full narrative         | ~5000 chars |

Retrieved graph memories contribute only their L0 abstracts as context candidates.
The assembler may include those candidates under the episodic or knowledge budget;
L1/L2 content is not copied into the assembled prompt and remains available through
the existing on-demand recall path.

### Categories

Each memory is classified into one of six categories:

| Category     | What it captures         | Example                                |
| ------------ | ------------------------ | -------------------------------------- |
| `profile`    | Name, age, location, job | "User is a backend engineer in Berlin" |
| `preference` | Likes, dislikes, style   | "User prefers concise answers"         |
| `entity`     | Projects, people, tools  | "User's main project is called Atlas"  |
| `event`      | Decisions, milestones    | "User migrated from Postgres to Redis" |
| `pattern`    | Recurring behaviors      | "User debugs by reading logs first"    |
| `case`       | Problems + solutions     | "Fixed OOM by switching to streaming"  |

### Metadata

Every memory also carries:

- **Strength** (0.0-1.0) -- how vivid the memory is; decays over time
- **Decay rate** (default 0.1) -- how fast it fades; slows with repeated access
- **Confidence** (0.0-1.0) -- how certain the system is about this fact
- **Provenance** -- where it came from: `stated`, `extracted`, `inferred`, `consolidated`, or `resource`
- **Access count** -- how many times it's been retrieved
- **Emotional valence/intensity** -- the emotional context when created (optional)
- **Source** -- which channel and session produced it

---

## Context hierarchy projection

Graph memories are projected into the context hierarchy without migration. A memory
is classified as knowledge when `sourceResourceId` is non-null, `provenance` is
`resource`, or `sourceChannel` is `knowledge`; all other graph memories are
episodic. The graph remains the source persistence, so no row rewrite, duplication,
or schema migration is required.

The graph adapter exposes only `abstract` as the full `graph-memory.l0`
representation. Retrieval source, normalized score, rank, category match, graph
relation, and opaque source references remain typed metadata used for ordering and
the content-free trace.

Stable blocks follow a different path. The orchestrator reads current block
snapshots directly in canonical layer/order/ID order, without similarity retrieval,
then adapts persisted `content` as the model representation. Labels, descriptions,
confidence, provenance details, and revision actor metadata are not copied into
model content.

Historical chat messages and an existing rolling session summary form the working
layer. The current request stays outside the hierarchy in its native user role.
See [`CONTEXT.md`](CONTEXT.md) for policy and
[`context-assembly-runtime.md`](context-assembly-runtime.md) for the execution path.

---

## Structured memory blocks (B11)

Structured blocks are persisted separately from graph-memory nodes. B11 accepts
only stable `identity`, `human`, and `procedural` blocks. Identity and human blocks
are user-managed; procedural blocks may be user- or agent-managed. Each strict v1
document carries its schema version, layer, manager, label, nullable description,
content, character budget, declared order, layer-specific procedural priority,
read-only state, confidence, structured provenance, and nullable verification
time.

A block's character budget is a persistence bound. Every create, update, and
restore must satisfy it before a revision is committed, using a deterministic count
of Unicode code points. It is not a token estimate and is independent of the model
tokenizer. B12 accounts for the selected rendered representation separately using
its conservative, versioned UTF-8-byte upper-bound profile.

Creating a block establishes revision 1. Updates and restores append immutable full
snapshots and atomically advance the current revision. Both require the caller's
expected current revision; a stale value is rejected rather than merged. Restore
copies a historical snapshot into a new revision instead of changing or deleting
history. The block's layer and manager cannot change after creation, and an agent
cannot alter a currently read-only block.

The authenticated `/api/memory-blocks` API provides bounded current-state reads,
full-snapshot writes, revision history, and restore. It uses dedicated
`memory-block:read` and `memory-block:write` API-key scopes, sends
`Cache-Control: no-store`, and keeps content out of validation errors and the
supplementary operational audit log. Trusted actor metadata is stored with every
revision; request bodies cannot choose their actor identity.

The B11 API does not define autonomous editing policy or a client UI. B12 only reads
the current canonical snapshots for context assembly; it does not write, restore,
or otherwise mutate blocks. The complete schema, Unicode budget, API, security,
audit, migration, and batch-boundary contract is in
[`structured-memory-blocks.md`](structured-memory-blocks.md).

### Runtime defaults and limits

Persistent context is enabled by default for interactive requests. Stable blocks
and graph-memory candidates are not supplied to `scheduler`, `pulse`, `webhook`, or
`daemon` turns, so B12 does not autonomously delegate persistent memory to those
background paths. Working candidates can still be built from messages explicitly
supplied to the turn.

B12 uses a rolling summary only when the gateway already supplies one. It does not
ask a model to create a summary during assembly, and the current block, working,
and graph adapters expose full forms only. There is no memory/context inspector UI
in B12. If any identity or human candidate is excluded, the server fails closed
with `ContextStableOverflowError`; the error contains only the candidate's opaque
canonical reference, while the shared pure assembler retains the full exclusion
diagnostic for direct callers.

---

## Memory graph

Memories don't exist in isolation. They're connected by **edges** that capture
relationships:

| Relation        | Meaning                                | Default weight |
| --------------- | -------------------------------------- | -------------- |
| `temporal`      | Happened around the same time          | 0.3            |
| `causal`        | A led to B                             | 0.5            |
| `semantic`      | Topically similar                      | 0.5            |
| `entity`        | Share a named entity (person, project) | 0.6            |
| `contradiction` | A conflicts with B                     | 0.5            |
| `supersedes`    | A replaces B (belief revision)         | 0.5            |
| `narrative`     | Part of the same story arc             | 0.7-0.8        |

Edge weights range from 0.0 to 1.0 and strengthen when two memories are
co-accessed in the same session (Hebbian learning: "fire together, wire
together").

### Spreading activation

When a memory is retrieved, the system "activates" its graph neighbors:

```
neighbor_score = edge_weight x neighbor_strength x relation_bonus
```

Relation bonuses amplify certain edge types during activation:

| Relation      | Bonus |
| ------------- | ----- |
| causal        | 1.5x  |
| entity        | 1.2x  |
| narrative     | 1.2x  |
| supersedes    | 1.1x  |
| temporal      | 1.0x  |
| semantic      | 0.8x  |
| contradiction | 0.3x  |

High-scoring neighbors are included in retrieval results, surfacing related
context that vector similarity alone would miss.

---

## Strength and decay

Memory strength follows an **Ebbinghaus-inspired exponential forgetting curve**:

```
strength(t) = strength_0 x e^(-decay_rate x days_since_last_access)
```

### How strength changes

| Event            | Effect                                                      |
| ---------------- | ----------------------------------------------------------- |
| **Created**      | Starts at 0.8 (or 0.6-1.0 based on emotional intensity)     |
| **Accessed**     | +0.15 strength (capped at 1.0), decay_rate x 0.8 (min 0.02) |
| **Time passes**  | Decays exponentially every 6 hours                          |
| **Consolidated** | Originals drop below 0.05 (invisible)                       |
| **Below 0.05**   | Still in DB but invisible to retrieval                      |

The spaced repetition effect means memories accessed repeatedly over longer
intervals become nearly permanent (decay rate approaches 0.02), while memories
accessed many times in a single session decay faster.

### Emotional memories

When emotions are enabled, emotional intensity at creation time affects initial
strength:

```
initial_strength = 0.6 + (emotional_intensity x 0.4)
```

High-emotion moments (breakthroughs, frustrations) create stronger memories.
When emotions are disabled, all memories start at a neutral 0.8.

---

## Extraction

Facts are extracted from conversations automatically:

1. Every N turns (configurable batch size), the last 10 messages are sent to a
   lightweight LLM
2. The LLM identifies new facts, classifying each by category, confidence, and
   provenance
3. Existing memories are included in the prompt to prevent re-extraction
4. Trivial messages (greetings, confirmations under 20 chars) are skipped

### Deduplication

Before storing, each extracted fact is checked for duplicates:

1. **Vector similarity** (primary) -- embed the new abstract, search for
   cosine similarity > 0.85
2. **Text matching** (fallback) -- substring overlap with length ratio >= 60%

If a duplicate is found and the new fact is richer (longer), the existing
memory is updated. Otherwise the duplicate is silently skipped.

### Edge creation during extraction

- **Entity edges** (weight 0.6) between memories mentioning the same named
  entities (word-boundary matching to avoid "Tom"/"tomato" false positives)
- **Temporal edges** (weight 0.3) between all facts extracted in the same batch

---

## Retrieval and scoring

When the system needs memories for a conversation, retrieval happens in stages:

### Stage 1: Vector search

Query text is embedded and matched against the memory vector index. Returns the
top N memories (default 15) above the strength threshold (0.05).

### Stage 2: Composite re-ranking

Each candidate memory is scored across multiple signals:

**With emotions enabled (5 signals):**

```
score = vector_similarity x 0.35
      + strength          x 0.25
      + recency           x 0.15
      + category_relevance x 0.15
      + emotional_resonance x 0.10
```

**With emotions disabled (4 signals):**

```
score = vector_similarity x 0.40
      + strength          x 0.30
      + recency           x 0.15
      + category_relevance x 0.15
```

The emotion toggle is read at query time, so switching it takes immediate
effect with no data migration.

### Stage 3: Context-aware category weighting

Category relevance adjusts based on the conversation channel:

| Channel                     | Boosted               | Reduced       |
| --------------------------- | --------------------- | ------------- |
| Technical (Discord, Slack)  | entity, pattern, case | profile       |
| Casual (Telegram, WhatsApp) | profile, preference   | case, pattern |
| Default (Web)               | All equal             | --            |

### Stage 4: Spreading activation

Direct matches trigger neighbor discovery through the memory graph. Associated
memories are tagged and included with lower priority.

### Stage 5: Predictive preloading

Based on topic transition patterns from the access log, the system predicts
which topics will come up next and preloads relevant memories.

The resulting direct, associated, and predicted rows are capped before assembly
and mapped to typed L0 candidates. Context assembly then reorders them by normalized
retrieval score, event time, and canonical reference and applies the episodic or
knowledge budget. The retrieval pipeline does not directly interpolate memory
bodies into the legacy prompt.

---

## Consolidation ("sleep" cycles)

Every 6 hours (when at least 5 new memories exist), the system runs four
consolidation passes:

### Pass 1: Fragment merging

Finds clusters of 3+ related memories (connected by semantic/temporal/entity
edges, same category) and merges them into a single coherent memory using an
LLM. Originals are reduced below the visibility threshold to prevent
re-merging.

> **Example:** Three separate memories about "User uses Postgres", "User's DB
> is on AWS RDS", "User's Postgres version is 15" become one consolidated
> memory: "User runs Postgres 15 on AWS RDS."

### Pass 2: Insight synthesis

Finds frequently-accessed memories (3+ accesses) across categories and asks an
LLM to identify higher-order patterns.

> **Example:** Memories about preferring simple solutions, choosing proven
> tools, and avoiding premature optimization yield: "User consistently
> prioritizes simplicity and pragmatism over theoretical elegance."

### Pass 3: Narrative weaving

Finds temporally-connected event memories and weaves them into timeline
narratives.

> **Example:** Three events about a database migration become: "User chose
> Postgres, hit scaling issues at 10M rows, evaluated alternatives, and
> migrated hot path to Redis while keeping Postgres for transactional data."

### Pass 4: Graph pruning

Cleans up the memory graph:

- Removes edges with weight < 0.1
- Deletes access log entries older than 90 days

---

## Predictive preloading

The access log tracks which memory topics tend to follow each other. Each
memory gets a **topic hash** (category + first keyword from its abstract):

```
"entity:postgres"
"preference:concise"
"pattern:debugging"
```

When topic A is accessed, the system checks historical transitions to predict
topic B and preloads its memories. This is like CPU cache prefetching, but for
conversational context.

---

## Configuration

All cognitive memory features can be toggled via the config store:

| Setting                       | Default | Description                          |
| ----------------------------- | ------- | ------------------------------------ |
| `memory.decayEnabled`         | `true`  | Enable/disable periodic decay passes |
| `memory.consolidationEnabled` | `true`  | Enable/disable consolidation cycles  |
| `memory.preloadingEnabled`    | `true`  | Enable/disable predictive preloading |
| `memory.strengthThreshold`    | `0.05`  | Below this, memories are invisible   |
| `memory.maxRetrievalCount`    | `20`    | Max memories returned per retrieval  |

Emotions are controlled separately via the persona settings
(`persona.emotionsEnabled`). Memory works fully without emotions -- they
enhance it but are never required.

---

## Database schema

Graph memory uses four tables introduced by migration v11:

- **`memory_nodes`** -- the memories themselves (20 columns)
- **`memory_edges`** -- graph connections between memories
- **`memory_access_log`** -- retrieval history for preloading
- **`memory_node_vec`** -- 384-dimensional vector embeddings (sqlite-vec)

Legacy memories from the old flat `memories` table are automatically migrated
on first run. The old table is preserved as `memories_v1_backup`.

Migration v35 adds `memory_blocks` and `memory_block_revisions` as separate
structured-block tables. It creates empty storage and does not rewrite, duplicate,
or reclassify graph-memory rows. Immutable snapshots, current-revision pointers,
and database constraints reinforce the B11 application-level validation.

---

## File map

| File                                                          | Role                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/server/src/db/memory-store.ts`                          | CRUD, vector search, dedup, clustering, decay                                       |
| `apps/server/src/lib/memory-extractor.ts`                     | LLM-based fact extraction from conversations                                        |
| `apps/server/src/lib/memory-decay.ts`                         | Periodic decay engine, initial strength calc                                        |
| `apps/server/src/lib/memory-graph.ts`                         | Spreading activation, edge boosting, entity linking                                 |
| `apps/server/src/lib/memory-projections.ts`                   | Composite scoring, channel-aware category weights                                   |
| `apps/server/src/lib/memory-consolidation.ts`                 | Fragment merging, insight synthesis, narrative weaving                              |
| `apps/server/src/lib/memory-preloader.ts`                     | Topic transitions, predictive memory loading                                        |
| `apps/server/src/db/config-store.ts`                          | Config getters/setters for memory settings                                          |
| `apps/server/src/db/migrations.ts`                            | Ordered SQLite migrations, including graph v11 and structured-block v35             |
| `apps/server/src/db/memory-block-store.ts`                    | Structured-block snapshots, revisions, restore, budgets, and optimistic concurrency |
| `apps/server/src/db/migrations/memory-blocks-v35.ts`          | Structured-block tables, constraints, indexes, and immutability triggers            |
| `apps/server/src/routes/memory-blocks.ts`                     | Authenticated, bounded structured-block HTTP API                                    |
| `apps/server/src/middleware/auth.ts`                          | Dedicated structured-block API-key scope boundary                                   |
| `apps/server/src/lib/orchestrator/context-block-adapter.ts`   | Current stable-block candidates                                                     |
| `apps/server/src/lib/orchestrator/context-memory-adapter.ts`  | Graph L0 candidates and episodic/knowledge mapping                                  |
| `apps/server/src/lib/orchestrator/context-working-adapter.ts` | Rolling-summary and historical-message candidates                                   |
| `apps/server/src/lib/orchestrator/context-assembler.ts`       | Window reservation, layer-cap allocation, and fail-closed stable overflow           |
| `packages/shared/src/lib/context-assembly.ts`                 | Pure deterministic selection, rendering, trace, and exclusion diagnostics           |
| `packages/shared/src/types/memory.ts`                         | TypeScript types for Memory, MemoryEdge, etc.                                       |
