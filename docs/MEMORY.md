# Cognitive Memory System

Chvor's memory system is a graph-based cognitive architecture inspired by how
human memory works: associative, decaying, emotionally-aware, self-organizing,
and context-adaptive. It replaces a flat key-value store with a living network
of interconnected facts that strengthens with use, fades with neglect, and
periodically reorganizes itself during idle "sleep" cycles.

---

## How it works (the short version)

When you talk to Chvor, the system:

1. **Extracts** facts from the conversation (your name, projects, preferences)
2. **Stores** them as tiered memory nodes with strength, confidence, and category
3. **Links** related memories with typed edges (temporal, causal, entity, etc.)
4. **Retrieves** relevant memories using vector similarity + composite scoring
5. **Strengthens** memories each time they're accessed (spaced repetition)
6. **Decays** unused memories over time (exponential forgetting curve)
7. **Consolidates** related fragments into coherent narratives during idle periods
8. **Predicts** which memories you'll need next based on topic transition patterns

The result: important, frequently-used facts stay vivid. Outdated or irrelevant
ones fade away. Related memories cluster together. The system learns what matters.

---

## Memory anatomy

Every memory is a **node** in a graph with three content tiers:

| Tier | Field | Purpose | Size |
|------|-------|---------|------|
| L0 | `abstract` | One-line summary | ~120 chars |
| L1 | `overview` | Paragraph with context | ~1000 chars |
| L2 | `detail` | Full narrative | ~5000 chars |

By default, only L0 abstracts are injected into the system prompt. L1/L2
content is loaded on demand when deeper context is needed.

### Categories

Each memory is classified into one of six categories:

| Category | What it captures | Example |
|----------|-----------------|---------|
| `profile` | Name, age, location, job | "User is a backend engineer in Berlin" |
| `preference` | Likes, dislikes, style | "User prefers concise answers" |
| `entity` | Projects, people, tools | "User's main project is called Atlas" |
| `event` | Decisions, milestones | "User migrated from Postgres to Redis" |
| `pattern` | Recurring behaviors | "User debugs by reading logs first" |
| `case` | Problems + solutions | "Fixed OOM by switching to streaming" |

### Metadata

Every memory also carries:

- **Strength** (0.0-1.0) -- how vivid the memory is; decays over time
- **Decay rate** (default 0.1) -- how fast it fades; slows with repeated access
- **Confidence** (0.0-1.0) -- how certain the system is about this fact
- **Provenance** -- where it came from: `stated`, `extracted`, `inferred`, or `consolidated`
- **Access count** -- how many times it's been retrieved
- **Emotional valence/intensity** -- the emotional context when created (optional)
- **Source** -- which channel and session produced it

---

## Memory graph

Memories don't exist in isolation. They're connected by **edges** that capture
relationships:

| Relation | Meaning | Default weight |
|----------|---------|----------------|
| `temporal` | Happened around the same time | 0.3 |
| `causal` | A led to B | 0.5 |
| `semantic` | Topically similar | 0.5 |
| `entity` | Share a named entity (person, project) | 0.6 |
| `contradiction` | A conflicts with B | 0.5 |
| `supersedes` | A replaces B (belief revision) | 0.5 |
| `narrative` | Part of the same story arc | 0.7-0.8 |

Edge weights range from 0.0 to 1.0 and strengthen when two memories are
co-accessed in the same session (Hebbian learning: "fire together, wire
together").

### Spreading activation

When a memory is retrieved, the system "activates" its graph neighbors:

```
neighbor_score = edge_weight x neighbor_strength x relation_bonus
```

Relation bonuses amplify certain edge types during activation:

| Relation | Bonus |
|----------|-------|
| causal | 1.5x |
| entity | 1.2x |
| narrative | 1.2x |
| supersedes | 1.1x |
| temporal | 1.0x |
| semantic | 0.8x |
| contradiction | 0.3x |

High-scoring neighbors are included in retrieval results, surfacing related
context that vector similarity alone would miss.

---

## Strength and decay

Memory strength follows an **Ebbinghaus-inspired exponential forgetting curve**:

```
strength(t) = strength_0 x e^(-decay_rate x days_since_last_access)
```

### How strength changes

| Event | Effect |
|-------|--------|
| **Created** | Starts at 0.8 (or 0.6-1.0 based on emotional intensity) |
| **Accessed** | +0.15 strength (capped at 1.0), decay_rate x 0.8 (min 0.02) |
| **Time passes** | Decays exponentially every 6 hours |
| **Consolidated** | Originals drop below 0.05 (invisible) |
| **Below 0.05** | Still in DB but invisible to retrieval |

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

| Channel | Boosted | Reduced |
|---------|---------|---------|
| Technical (Discord, Slack) | entity, pattern, case | profile |
| Casual (Telegram, WhatsApp) | profile, preference | case, pattern |
| Default (Web) | All equal | -- |

### Stage 4: Spreading activation

Direct matches trigger neighbor discovery through the memory graph. Associated
memories are tagged and included with lower priority.

### Stage 5: Predictive preloading

Based on topic transition patterns from the access log, the system predicts
which topics will come up next and preloads relevant memories.

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

| Setting | Default | Description |
|---------|---------|-------------|
| `memory.decayEnabled` | `true` | Enable/disable periodic decay passes |
| `memory.consolidationEnabled` | `true` | Enable/disable consolidation cycles |
| `memory.preloadingEnabled` | `true` | Enable/disable predictive preloading |
| `memory.strengthThreshold` | `0.05` | Below this, memories are invisible |
| `memory.maxRetrievalCount` | `20` | Max memories returned per retrieval |

Emotions are controlled separately via the persona settings
(`persona.emotionsEnabled`). Memory works fully without emotions -- they
enhance it but are never required.

---

## Database schema

The system uses four tables (migration v11):

- **`memory_nodes`** -- the memories themselves (20 columns)
- **`memory_edges`** -- graph connections between memories
- **`memory_access_log`** -- retrieval history for preloading
- **`memory_node_vec`** -- 384-dimensional vector embeddings (sqlite-vec)

Legacy memories from the old flat `memories` table are automatically migrated
on first run. The old table is preserved as `memories_v1_backup`.

---

## File map

| File | Role |
|------|------|
| `apps/server/src/db/memory-store.ts` | CRUD, vector search, dedup, clustering, decay |
| `apps/server/src/lib/memory-extractor.ts` | LLM-based fact extraction from conversations |
| `apps/server/src/lib/memory-decay.ts` | Periodic decay engine, initial strength calc |
| `apps/server/src/lib/memory-graph.ts` | Spreading activation, edge boosting, entity linking |
| `apps/server/src/lib/memory-projections.ts` | Composite scoring, channel-aware category weights |
| `apps/server/src/lib/memory-consolidation.ts` | Fragment merging, insight synthesis, narrative weaving |
| `apps/server/src/lib/memory-preloader.ts` | Topic transitions, predictive memory loading |
| `apps/server/src/db/config-store.ts` | Config getters/setters for memory settings |
| `apps/server/src/db/database.ts` | Schema definitions and migration v11 |
| `packages/shared/src/types/memory.ts` | TypeScript types for Memory, MemoryEdge, etc. |
