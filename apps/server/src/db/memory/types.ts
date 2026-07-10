import type { EdgeRelation, Memory, MemoryCategory, MemoryEdge, MemoryProvenance, MemorySpace } from "@chvor/shared";

// ─── Row types ──────────────────────────────────────────────

export interface MemoryNodeRow {
  id: string;
  abstract: string;
  overview: string | null;
  detail: string | null;
  category: string;
  space: string;
  strength: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: string | null;
  confidence: number;
  provenance: string;
  emotional_valence: number | null;
  emotional_intensity: number | null;
  source_channel: string;
  source_session_id: string;
  source_message_id: string | null;
  source_resource_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  created_at: string;
}

// ─── Row → Model mappers ────────────────────────────────────

export function rowToMemory(row: MemoryNodeRow): Memory {
  return {
    id: row.id,
    abstract: row.abstract,
    overview: row.overview,
    detail: row.detail,
    category: row.category as MemoryCategory,
    space: row.space as MemorySpace,
    strength: row.strength,
    decayRate: row.decay_rate,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    confidence: row.confidence,
    provenance: row.provenance as MemoryProvenance,
    emotionalValence: row.emotional_valence,
    emotionalIntensity: row.emotional_intensity,
    sourceChannel: row.source_channel,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id,
    sourceResourceId: row.source_resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Backward-compat: content = abstract (used by UI, health-manifest, etc.)
    content: row.abstract,
  };
}

export function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation as EdgeRelation,
    weight: row.weight,
    createdAt: row.created_at,
  };
}
