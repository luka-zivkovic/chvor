import { tool } from "ai";
import { z } from "zod";
import { join } from "node:path";
import { validateFetchUrl } from "./security.ts";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Knowledge: ingest_url + ingest_document
// ---------------------------------------------------------------------------

const INGEST_URL_NAME = "native__ingest_url";
const INGEST_DOCUMENT_NAME = "native__ingest_document";

const ingestUrlToolDef = tool({
  description:
    "[Knowledge] Ingest a web page URL — fetches the page, extracts text, and stores facts into memory. " +
    "Use when a user shares a URL they want you to remember or learn from.",
  parameters: z.object({
    url: z.string().describe("The URL to ingest"),
    title: z.string().optional().describe("Optional title for the resource"),
  }),
});

const ingestDocumentToolDef = tool({
  description:
    "[Knowledge] Ingest an uploaded document (PDF, DOCX, TXT, image) from its media ID — extracts text and stores facts into memory.",
  parameters: z.object({
    mediaId: z.string().describe("The media artifact ID (from a previous upload)"),
    title: z.string().optional().describe("Optional title for the resource"),
  }),
});

const handleIngestUrl: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const { createResource } = await import("../../db/knowledge-store.ts");
  const { ingestResource } = await import("../knowledge-ingestor.ts");

  const url = String(args.url ?? "").trim();
  if (!url) {
    return { content: [{ type: "text", text: "Please provide a URL to ingest." }] };
  }

  try {
    new URL(url);
  } catch {
    return { content: [{ type: "text", text: `Invalid URL: ${url}` }] };
  }

  try {
    await validateFetchUrl(url);
  } catch (err) {
    return { content: [{ type: "text", text: `Blocked: ${(err as Error).message}` }] };
  }

  const title = String(args.title || new URL(url).hostname);
  const resource = createResource({ type: "url", title, sourceUrl: url });

  // Await ingestion so we can report results
  try {
    await ingestResource(resource.id);
    const { getResource } = await import("../../db/knowledge-store.ts");
    const updated = getResource(resource.id);
    const count = updated?.memoryCount ?? 0;
    return {
      content: [{ type: "text", text: `Ingested "${title}" — extracted ${count} fact${count !== 1 ? "s" : ""} into memory.` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Ingestion failed: ${(err as Error).message}` }],
    };
  }
};

const handleIngestDocument: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const { createResource } = await import("../../db/knowledge-store.ts");
  const { ingestResource } = await import("../knowledge-ingestor.ts");
  const { getMediaDir } = await import("../media-store.ts");

  const mediaId = String(args.mediaId ?? "").trim();
  if (!mediaId) {
    return { content: [{ type: "text", text: "Please provide a mediaId." }] };
  }

  // Validate mediaId is a UUID to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId)) {
    return { content: [{ type: "text", text: "Invalid mediaId format." }] };
  }

  // Detect file type by checking known extensions directly (avoid readdirSync scan)
  const { existsSync } = await import("node:fs");
  const mediaDir = getMediaDir();

  const extCandidates = ["pdf", "docx", "txt", "md", "png", "jpg", "jpeg", "webp"];
  let ext = "";
  for (const candidate of extCandidates) {
    if (existsSync(join(mediaDir, `${mediaId}.${candidate}`))) {
      ext = candidate;
      break;
    }
  }
  if (!ext) {
    return { content: [{ type: "text", text: `No media file found with ID: ${mediaId}` }] };
  }

  const filename = `${mediaId}.${ext}`;
  const typeMap: Record<string, { type: string; mime: string }> = {
    pdf: { type: "pdf", mime: "application/pdf" },
    docx: { type: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    txt: { type: "txt", mime: "text/plain" },
    md: { type: "markdown", mime: "text/markdown" },
    png: { type: "image", mime: "image/png" },
    jpg: { type: "image", mime: "image/jpeg" },
    jpeg: { type: "image", mime: "image/jpeg" },
    webp: { type: "image", mime: "image/webp" },
  };

  const info = typeMap[ext];
  if (!info) {
    return { content: [{ type: "text", text: `Unsupported file type: .${ext}` }] };
  }

  const title = String(args.title || filename);
  const resource = createResource({
    type: info.type as import("@chvor/shared").KnowledgeResourceType,
    title,
    mediaId,
    mimeType: info.mime,
  });

  try {
    await ingestResource(resource.id);
    const { getResource } = await import("../../db/knowledge-store.ts");
    const updated = getResource(resource.id);
    const count = updated?.memoryCount ?? 0;
    return {
      content: [{ type: "text", text: `Ingested "${title}" — extracted ${count} fact${count !== 1 ? "s" : ""} into memory.` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Ingestion failed: ${(err as Error).message}` }],
    };
  }
};

export const knowledgeModule: NativeToolModule = {
  defs: {
    [INGEST_URL_NAME]: ingestUrlToolDef,
    [INGEST_DOCUMENT_NAME]: ingestDocumentToolDef,
  },
  handlers: {
    [INGEST_URL_NAME]: handleIngestUrl,
    [INGEST_DOCUMENT_NAME]: handleIngestDocument,
  },
};
