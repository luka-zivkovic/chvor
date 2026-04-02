// ─── Memory Categories ──────────────────────────────────────

export type MemoryCategory =
  | "profile"     // name, age, location, job
  | "preference"  // likes, dislikes, communication style
  | "entity"      // projects, people, companies, tools
  | "event"       // decisions, milestones, incidents
  | "pattern"     // recurring behaviors, habits, workflows
  | "case";       // specific problems + solutions

export type MemorySpace = "user" | "agent";

export type MemoryProvenance = "extracted" | "stated" | "inferred" | "consolidated" | "resource";

export type EdgeRelation =
  | "temporal"       // happened around the same time
  | "causal"         // A led to B
  | "semantic"       // topically similar
  | "entity"         // share a named entity
  | "contradiction"  // A conflicts with B
  | "supersedes"     // A replaces B (belief revision)
  | "narrative";     // part of the same story arc

// ─── Core Memory Node ───────────────────────────────────────

export interface Memory {
  id: string;
  // Content tiers (L0/L1/L2)
  abstract: string;          // L0: one-line summary
  overview: string | null;   // L1: paragraph context
  detail: string | null;     // L2: full narrative
  // Categorization
  category: MemoryCategory;
  space: MemorySpace;
  // Strength & decay
  strength: number;          // 0.0–1.0
  decayRate: number;         // lower = slower decay
  accessCount: number;
  lastAccessedAt: string | null;
  // Confidence & provenance
  confidence: number;        // 0.0–1.0
  provenance: MemoryProvenance;
  // Emotion binding (nullable — emotions are optional)
  emotionalValence: number | null;
  emotionalIntensity: number | null;
  // Source tracking
  sourceChannel: string;
  sourceSessionId: string;
  sourceMessageId: string | null;
  sourceResourceId: string | null;
  // Timestamps
  createdAt: string;
  updatedAt: string;
  // Backward-compat: derived field for UI/API consumers expecting flat content
  content: string;
}

// ─── Graph Edges ────────────────────────────────────────────

export interface MemoryEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: EdgeRelation;
  weight: number;
  createdAt: string;
}

export interface MemoryGraphNeighbor {
  memory: Memory;
  relation: EdgeRelation;
  edgeWeight: number;
}

// ─── API Requests ───────────────────────────────────────────

export interface CreateMemoryRequest {
  content: string;
  category?: MemoryCategory;
}

export interface UpdateMemoryRequest {
  content: string;
}

// ─── Graph Visualization Types ─────────────────────────────

/** Lightweight memory node for graph visualization (no content tiers or embeddings) */
export interface MemoryGraphNode {
  id: string;
  abstract: string;
  category: MemoryCategory;
  space: MemorySpace;
  strength: number;
  decayRate: number;
  accessCount: number;
  lastAccessedAt: string | null;
  confidence: number;
  provenance: MemoryProvenance;
  emotionalValence: number | null;
  emotionalIntensity: number | null;
  sourceChannel: string;
  createdAt: string;
}

export interface MemoryGraphExport {
  nodes: MemoryGraphNode[];
  edges: MemoryEdge[];
}

export interface MemoryStats {
  totalMemories: number;
  totalEdges: number;
  categoryBreakdown: Array<{ category: string; count: number }>;
  provenanceBreakdown: Array<{ provenance: string; count: number }>;
  relationBreakdown: Array<{ relation: string; count: number }>;
  strengthDistribution: Array<{ bucket: string; count: number }>;
  avgStrength: number;
  avgConfidence: number;
  oldestMemory: string | null;
  newestMemory: string | null;
  recentCount7d: number;
  weakCount: number;
  topAccessed: Array<{ id: string; abstract: string; accessCount: number }>;
}
