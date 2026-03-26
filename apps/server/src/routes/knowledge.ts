import { Hono } from "hono";
import {
  createResource,
  getResource,
  listResources,
  deleteResource,
  deleteMemoriesForResource,
  getMemoriesForResource,
  updateResourceStatus,
  prepareReprocess,
} from "../db/knowledge-store.ts";
import { ingestResource } from "../lib/knowledge-ingestor.ts";
import { storeMediaFromBuffer, MAX_ARTIFACT_BYTES } from "../lib/media-store.ts";
import { validateFetchUrl } from "../lib/native-tools.ts";
import type { KnowledgeResourceType, IngestUrlRequest } from "@chvor/shared";

const knowledge = new Hono();

// ─── Magic-byte validation ────────────────────────────────

function validateMagicBytes(buffer: Buffer, claimedMime: string): boolean {
  if (claimedMime === "application/pdf") {
    // PDF: starts with %PDF
    return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  }
  if (claimedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    // DOCX is a ZIP: starts with PK (0x50 0x4B)
    return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4B;
  }
  if (claimedMime === "image/png") {
    // PNG: 89 50 4E 47
    return buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  }
  if (claimedMime === "image/jpeg") {
    // JPEG: FF D8 FF
    return buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  }
  if (claimedMime === "image/webp") {
    // WebP: RIFF....WEBP
    return buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
  }
  // text/plain and text/markdown — no reliable magic bytes, accept as-is
  return true;
}

// ─── List all resources ───────────────────────────────────

knowledge.get("/", (c) => {
  try {
    return c.json({ data: listResources() });
  } catch (err) {
    console.error("[knowledge] request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Upload a file ────────────────────────────────────────

const ACCEPTED_TYPES: Record<string, KnowledgeResourceType> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/markdown": "markdown",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

knowledge.post("/upload", async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || !(file instanceof File)) {
      return c.json({ error: "Missing file field" }, 400);
    }

    const mimeType = file.type || "application/octet-stream";
    const resourceType = ACCEPTED_TYPES[mimeType];
    if (!resourceType) {
      return c.json(
        { error: `Unsupported file type: ${mimeType}. Accepted: ${Object.keys(ACCEPTED_TYPES).join(", ")}` },
        400,
      );
    }

    // Size limit
    if (file.size > MAX_ARTIFACT_BYTES) {
      return c.json({ error: `File too large (max ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB)` }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Validate magic bytes match claimed MIME type
    if (!validateMagicBytes(buffer, mimeType)) {
      return c.json({ error: "File content does not match declared type" }, 400);
    }

    const artifact = storeMediaFromBuffer(buffer, mimeType, file.name);

    const title = (body["title"] as string) || file.name || "Untitled";

    const resource = createResource({
      type: resourceType,
      title,
      mediaId: artifact.id,
      mimeType,
      fileSize: file.size,
    });

    // Fire-and-forget ingestion
    ingestResource(resource.id).catch((err) =>
      console.error("[knowledge] background ingestion failed:", err),
    );

    return c.json({ data: resource }, 202);
  } catch (err) {
    console.error("[knowledge] request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Ingest a URL ─────────────────────────────────────────

knowledge.post("/url", async (c) => {
  try {
    const body = (await c.req.json()) as IngestUrlRequest;

    if (!body.url || typeof body.url !== "string") {
      return c.json({ error: "Missing url field" }, 400);
    }

    if (body.url.length > 4096) {
      return c.json({ error: "URL too long (max 4096 characters)" }, 400);
    }

    // URL validation + SSRF check
    try {
      new URL(body.url);
    } catch {
      return c.json({ error: "Invalid URL" }, 400);
    }

    try {
      await validateFetchUrl(body.url);
    } catch (err) {
      return c.json({ error: `Blocked URL: ${(err as Error).message}` }, 400);
    }

    const title = body.title || new URL(body.url).hostname;

    const resource = createResource({
      type: "url",
      title,
      sourceUrl: body.url,
    });

    // Fire-and-forget ingestion
    ingestResource(resource.id).catch((err) =>
      console.error("[knowledge] background URL ingestion failed:", err),
    );

    return c.json({ data: resource }, 202);
  } catch (err) {
    console.error("[knowledge] request error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── Get single resource ─────────────────────────────────

knowledge.get("/:id", (c) => {
  const resource = getResource(c.req.param("id"));
  if (!resource) return c.json({ error: "Not found" }, 404);
  return c.json({ data: resource });
});

// ─── Get memories for resource ────────────────────────────

knowledge.get("/:id/memories", (c) => {
  const resource = getResource(c.req.param("id"));
  if (!resource) return c.json({ error: "Not found" }, 404);
  return c.json({ data: getMemoriesForResource(resource.id) });
});

// ─── Delete resource ──────────────────────────────────────

knowledge.delete("/:id", (c) => {
  const deleted = deleteResource(c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ data: { deleted: true } });
});

// ─── Reprocess resource ──────────────────────────────────

knowledge.post("/:id/reprocess", (c) => {
  const id = c.req.param("id");
  const resource = getResource(id);
  if (!resource) return c.json({ error: "Not found" }, 404);

  // Atomically check status, set to pending, and delete linked memories
  const result = prepareReprocess(id);
  if (!result) {
    return c.json({ error: "Resource is currently being processed" }, 409);
  }

  console.log(`[knowledge] reprocess: removed ${result.removed} existing memories for ${resource.title}`);

  // Re-run ingestion
  ingestResource(id).catch((err) =>
    console.error("[knowledge] reprocess ingestion failed:", err),
  );

  return c.json({ data: { reprocessing: true, removedMemories: result.removed } }, 202);
});

export default knowledge;
