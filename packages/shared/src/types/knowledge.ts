// ─── Knowledge Resource Types ─────────────────────────────

export type KnowledgeResourceType = "pdf" | "docx" | "txt" | "url" | "image" | "markdown";

export type KnowledgeStatus = "pending" | "processing" | "completed" | "failed";

export interface KnowledgeResource {
  id: string;
  type: KnowledgeResourceType;
  title: string;
  sourceUrl: string | null;
  mediaId: string | null;
  mimeType: string | null;
  fileSize: number | null;
  contentText: string | null;
  status: KnowledgeStatus;
  error: string | null;
  memoryCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── API Requests ─────────────────────────────────────────

export interface IngestUrlRequest {
  url: string;
  title?: string;
}

export interface ReprocessRequest {
  id: string;
}
