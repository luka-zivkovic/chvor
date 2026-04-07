/**
 * Knowledge Ingestion Pipeline — extracts text from multi-modal resources,
 * chunks it, runs LLM fact extraction, and stores memories linked to the resource.
 */

import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { generateText } from "ai";
import { createModelForRole } from "./llm-router.ts";
import {
  createMemory,
  findTopKSimilarMemories,
  mergeMemoryAbstract,
  getAllMemoryContents,
} from "../db/memory-store.ts";
import type { CreateMemoryOptions } from "../db/memory-store.ts";
import {
  getResource,
  updateResourceStatus,
  updateResourceContentText,
  setMemoryCount,
  deleteMemoriesForResource,
} from "../db/knowledge-store.ts";
import { getMediaDir, mimeToExt } from "./media-store.ts";
import { validateFetchUrl } from "./native-tools.ts";
import { extractDocxText } from "./docx-extractor.ts";
import { containsSensitiveData, redactSensitiveData } from "./sensitive-filter.ts";
import { isEmbedderAvailable } from "./embedder.ts";
import type { KnowledgeResource, MemoryCategory, MemoryProvenance } from "@chvor/shared";

// ─── Constants ────────────────────────────────────────────

const CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 500;
const MAX_CHUNKS = 50;
const MAX_LLM_DEDUP_PER_CHUNK = 3;
const MAX_FETCH_BODY_BYTES = 5 * 1024 * 1024; // 5 MB max for URL fetches

const RESOURCE_EXTRACTION_PROMPT = `Extract memorable facts from this document excerpt as a JSON array of objects.

Each object must have:
- "abstract": one concise sentence summarizing the fact (max 120 chars)
- "overview": a paragraph with context (2-3 sentences, optional, null if simple fact)
- "category": one of "profile", "preference", "entity", "event", "pattern", "case"
- "confidence": 0.0–1.0 how certain you are
- "relatedEntities": array of entity names mentioned (people, projects, tools, companies)

Categories:
- profile: personal info about the user
- preference: likes, dislikes, preferences
- entity: projects, people, companies, tools mentioned
- event: decisions, milestones, incidents
- pattern: recurring behaviors, workflows
- case: specific problems + solutions

Rules:
- Extract concrete, useful facts — not summaries of the text structure.
- Do NOT extract general knowledge or commonly known information.
- NEVER include credentials, API keys, tokens, passwords, or secrets.
- Focus on information that would be useful for a personal AI assistant to remember.
- Return ONLY a JSON array. Empty array [] if nothing useful.`;

const IMAGE_EXTRACTION_PROMPT = `Describe the key facts, information, and content shown in this image.
Focus on extractable knowledge: names, data, concepts, relationships, decisions, or workflows.
Skip purely decorative elements. Return a structured description.`;

// ─── Ingestion Queue ──────────────────────────────────────

const ingestionChains = new Map<string, Promise<void>>();

// Global concurrency limiter — at most N ingestions run LLM calls simultaneously
const MAX_CONCURRENT_INGESTIONS = 3;
let activeIngestions = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeIngestions < MAX_CONCURRENT_INGESTIONS) {
    activeIngestions++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waitQueue.push(() => { activeIngestions++; resolve(); }));
}

function releaseSlot(): void {
  activeIngestions--;
  const next = waitQueue.shift();
  if (next) next();
}

/**
 * Ingest a resource — async, fire-and-forget.
 * Uses per-resource promise chains + global concurrency cap.
 */
export function ingestResource(resourceId: string): Promise<void> {
  const prev = ingestionChains.get(resourceId) ?? Promise.resolve();
  const next = prev
    .then(() => doIngestion(resourceId))
    .catch((err) => {
      console.error(`[knowledge] ingestion failed for ${resourceId}:`, err);
      updateResourceStatus(resourceId, "failed", (err as Error).message);
    });

  ingestionChains.set(resourceId, next);

  next.then(() => {
    if (ingestionChains.get(resourceId) === next) {
      ingestionChains.delete(resourceId);
    }
  });

  return next;
}

// ─── Core Pipeline ────────────────────────────────────────

async function doIngestion(resourceId: string): Promise<void> {
  await acquireSlot();
  try {
    await doIngestionInner(resourceId);
  } finally {
    releaseSlot();
  }
}

async function doIngestionInner(resourceId: string): Promise<void> {
  const resource = getResource(resourceId);
  if (!resource) throw new Error(`Resource ${resourceId} not found`);

  // Clear any partial memories from a previous crashed run to prevent duplicates
  const removed = deleteMemoriesForResource(resourceId);
  if (removed > 0) {
    console.log(`[knowledge] cleared ${removed} partial memories from previous run for ${resource.title}`);
    setMemoryCount(resourceId, 0);
  }

  updateResourceStatus(resourceId, "processing");
  console.log(`[knowledge] starting ingestion: ${resource.title} (${resource.type})`);

  // Step 1: Extract text
  const text = await extractText(resource);

  if (!text || text.trim().length < 10) {
    updateResourceStatus(resourceId, "completed");
    console.log(`[knowledge] no extractable content for ${resource.title}`);
    return;
  }

  // Store extracted text for re-processing (redact secrets to prevent DB leaks)
  updateResourceContentText(resourceId, redactSensitiveData(text));

  // Step 2: Chunk
  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS) {
    console.warn(`[knowledge] truncating ${resource.title}: ${chunks.length} chunks → ${MAX_CHUNKS}`);
  }

  // Step 3: Extract facts from each chunk
  // Start with existing facts; accumulate newly created abstracts to prevent re-extraction
  const existingFacts = getAllMemoryContents(50_000);
  let totalMemories = 0;

  for (const chunk of chunks.slice(0, MAX_CHUNKS)) {
    try {
      const { count, newAbstracts } = await extractFactsFromChunk(chunk, existingFacts, resourceId);
      totalMemories += count;
      existingFacts.push(...newAbstracts);
    } catch (err) {
      console.warn(`[knowledge] chunk extraction failed, continuing:`, (err as Error).message);
    }
  }

  setMemoryCount(resourceId, totalMemories);
  updateResourceStatus(resourceId, "completed");
  console.log(`[knowledge] completed: ${resource.title} → ${totalMemories} facts from ${Math.min(chunks.length, MAX_CHUNKS)} chunks`);
}

// ─── Text Extraction ──────────────────────────────────────

async function extractText(resource: KnowledgeResource): Promise<string> {
  switch (resource.type) {
    case "txt":
    case "markdown":
      return readResourceFile(resource);

    case "pdf":
      return extractPdfText(resource);

    case "docx":
      return extractDocxFromResource(resource);

    case "url":
      return fetchUrlText(resource);

    case "image":
      return extractImageDescription(resource);

    default:
      throw new Error(`Unsupported resource type: ${resource.type}`);
  }
}

function readResourceFile(resource: KnowledgeResource): string {
  if (!resource.mediaId) throw new Error("No mediaId for file resource");
  const buffer = readMediaBuffer(resource.mediaId, resource.mimeType);
  let text = buffer.toString("utf-8");

  // Strip markdown frontmatter if present
  if (resource.type === "markdown") {
    const match = text.match(/^---\n[\s\S]*?\n---\n/);
    if (match) text = text.slice(match[0].length);
  }

  return text;
}

async function extractPdfText(resource: KnowledgeResource): Promise<string> {
  if (!resource.mediaId) throw new Error("No mediaId for PDF resource");
  const buffer = readMediaBuffer(resource.mediaId, resource.mimeType);

  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function extractDocxFromResource(resource: KnowledgeResource): string {
  if (!resource.mediaId) throw new Error("No mediaId for DOCX resource");
  const buffer = readMediaBuffer(resource.mediaId, resource.mimeType);
  return extractDocxText(buffer);
}

async function fetchUrlText(resource: KnowledgeResource): Promise<string> {
  const url = resource.sourceUrl;
  if (!url) throw new Error("No source URL for URL resource");

  await validateFetchUrl(url);

  const MAX_REDIRECTS = 5;
  let currentUrl = url;
  let resp: Response | undefined;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    resp = await fetch(currentUrl, {
      headers: {
        "User-Agent": "Chvor/1.0 (knowledge ingestion)",
        Accept: "text/html,text/plain,application/json",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) throw new Error(`Redirect with no Location header (HTTP ${resp.status})`);
      const redirectUrl = new URL(location, currentUrl);
      await validateFetchUrl(redirectUrl.href);
      currentUrl = redirectUrl.href;
      if (i === MAX_REDIRECTS) throw new Error(`Too many redirects (followed ${MAX_REDIRECTS})`);
      continue;
    }
    break;
  }

  if (!resp || !resp.ok) throw new Error(`HTTP ${resp?.status}: ${resp?.statusText}`);

  // Enforce response body size limit to prevent memory exhaustion
  const contentLength = resp.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_BODY_BYTES) {
    throw new Error(`Response too large (${contentLength} bytes, max ${MAX_FETCH_BODY_BYTES})`);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_FETCH_BODY_BYTES) {
      reader.cancel();
      throw new Error(`Response too large (exceeded ${MAX_FETCH_BODY_BYTES} bytes)`);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  // Plain text or JSON — return as-is
  if (contentType.includes("text/plain") || contentType.includes("application/json")) {
    return body;
  }

  // HTML — strip tags
  return stripHtml(body);
}

function stripHtml(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Replace block elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br)[^>]*>/gi, "\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode numeric entities (&#NNN; and &#xHHH;) with bounds checking
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : match;
  });
  text = text.replace(/&#(\d+);/g, (match, dec) => {
    const cp = parseInt(dec, 10);
    return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : match;
  });
  // Decode common named entities
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "\u2018").replace(/&rsquo;/g, "\u2019").replace(/&ldquo;/g, "\u201C").replace(/&rdquo;/g, "\u201D")
    .replace(/&hellip;/g, "…");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

async function extractImageDescription(resource: KnowledgeResource): Promise<string> {
  if (!resource.mediaId) throw new Error("No mediaId for image resource");
  const buffer = readMediaBuffer(resource.mediaId, resource.mimeType);
  const mimeType = (resource.mimeType || "image/png") as "image/png" | "image/jpeg" | "image/webp";

  let model;
  try {
    model = createModelForRole("primary");
  } catch {
    throw new Error("No LLM model available for image understanding");
  }

  const result = await generateText({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: buffer, mimeType },
          { type: "text", text: IMAGE_EXTRACTION_PROMPT },
        ],
      },
    ],
    maxTokens: 1000,
    abortSignal: AbortSignal.timeout(60_000),
  });

  return result.text;
}

// ─── Chunking ─────────────────────────────────────────────

export function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
}

// ─── Fact Extraction ──────────────────────────────────────

interface ExtractedFact {
  abstract: string;
  overview?: string | null;
  category?: MemoryCategory;
  confidence?: number;
  relatedEntities?: string[];
}

const VALID_CATEGORIES = new Set<string>(["profile", "preference", "entity", "event", "pattern", "case"]);

async function extractFactsFromChunk(
  chunk: string,
  existingFacts: string[],
  resourceId: string,
): Promise<{ count: number; newAbstracts: string[] }> {
  let model;
  try {
    model = createModelForRole("lightweight");
  } catch {
    console.warn("[knowledge] LLM unavailable, skipping chunk");
    return { count: 0, newAbstracts: [] };
  }

  const existingContext = existingFacts.length > 0
    ? `\n\nAlready known facts (do not re-extract):\n${existingFacts.slice(-100).map((f) => `- ${f}`).join("\n")}`
    : "";

  const result = await generateText({
    model,
    prompt: `${RESOURCE_EXTRACTION_PROMPT}${existingContext}\n\n---\nDocument excerpt:\n${chunk}`,
    maxTokens: 2000,
    abortSignal: AbortSignal.timeout(30_000),
  });

  let raw = result.text.trim();
  // Strip markdown fences
  raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  let facts: ExtractedFact[];
  try {
    const parsed = JSON.parse(raw);
    facts = Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("[knowledge] failed to parse extraction result, skipping chunk");
    return { count: 0, newAbstracts: [] };
  }

  let created = 0;
  const newAbstracts: string[] = [];
  let dedupBudget = MAX_LLM_DEDUP_PER_CHUNK;

  for (const fact of facts) {
    if (!fact.abstract || typeof fact.abstract !== "string") continue;
    if (fact.abstract.length < 5 || fact.abstract.length > 200) continue;
    if (containsSensitiveData(fact.abstract)) continue;
    if (typeof fact.overview === "string" && containsSensitiveData(fact.overview)) continue;

    // Dedup via vector similarity (or text fallback when embedder unavailable)
    const similar = await findTopKSimilarMemories(fact.abstract, 1, 0.5);

    if (similar.length > 0 && similar[0].similarity > 0.95) {
      // Exact duplicate — skip
      continue;
    }

    if (similar.length > 0 && similar[0].similarity > 0.8) {
      if (dedupBudget <= 0) continue;
      dedupBudget--;

      // LLM dedup decision
      try {
        const decision = await decideDuplicate(fact.abstract, similar[0].memory.abstract);
        if (decision === "SKIP") continue;
        if (decision === "MERGE") {
          const overview = typeof fact.overview === "string" ? fact.overview : null;
          mergeMemoryAbstract(similar[0].memory.id, fact.abstract, overview);
          continue;
        }
      } catch {
        continue;
      }
    }

    // Text-based dedup fallback when embedder is unavailable
    if (similar.length === 0 && !isEmbedderAvailable()) {
      const lower = fact.abstract.toLowerCase();
      if (existingFacts.some((f) => f.toLowerCase() === lower)) {
        continue;
      }
    }

    // Validate and sanitize extracted fields
    const category: MemoryCategory = (typeof fact.category === "string" && VALID_CATEGORIES.has(fact.category))
      ? fact.category as MemoryCategory
      : "entity";
    const confidence = typeof fact.confidence === "number" && fact.confidence >= 0 && fact.confidence <= 1
      ? fact.confidence
      : 0.85;
    const overview = typeof fact.overview === "string" ? fact.overview : null;

    // Create new memory linked to this resource
    const opts: CreateMemoryOptions = {
      abstract: fact.abstract.slice(0, 120),
      overview,
      detail: null,
      category,
      confidence,
      provenance: "resource" as MemoryProvenance,
      sourceChannel: "knowledge",
      sourceSessionId: "knowledge-ingestion",
      sourceResourceId: resourceId,
    };

    createMemory(opts);
    newAbstracts.push(opts.abstract);
    created++;
  }

  return { count: created, newAbstracts };
}

async function decideDuplicate(newFact: string, existingFact: string): Promise<"CREATE" | "SKIP" | "MERGE"> {
  let model;
  try {
    model = createModelForRole("lightweight");
  } catch {
    return "CREATE";
  }

  const result = await generateText({
    model,
    prompt: `Compare these two facts and decide:
- SKIP if they say the same thing
- MERGE if the new fact updates/improves the existing one
- CREATE if they are different facts

Existing: "${existingFact}"
New: "${newFact}"

Reply with exactly one word: CREATE, SKIP, or MERGE`,
    maxTokens: 10,
    abortSignal: AbortSignal.timeout(15_000),
  });

  const decision = result.text.trim().toUpperCase();
  if (decision === "SKIP" || decision === "MERGE" || decision === "CREATE") return decision;
  return "CREATE";
}

// ─── Helpers ──────────────────────────────────────────────

function readMediaBuffer(mediaId: string, mimeType: string | null): Buffer {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId)) {
    throw new Error("Invalid mediaId format");
  }
  const ext = mimeToExt(mimeType ?? "application/octet-stream");
  const mediaDir = getMediaDir();
  const filePath = join(mediaDir, `${mediaId}.${ext}`);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(mediaDir) + sep) && resolved !== resolve(mediaDir)) {
    throw new Error("Path traversal detected");
  }
  return readFileSync(filePath);
}
