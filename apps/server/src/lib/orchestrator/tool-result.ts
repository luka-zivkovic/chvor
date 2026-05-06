import type { MediaArtifact } from "@chvor/shared";
import { listCredentials } from "../../db/credential-store.ts";
import { LLM_CRED_TYPES } from "../provider-registry.ts";
import { redactSensitiveData } from "../sensitive-filter.ts";
import { storeMediaFromBase64 } from "../media-store.ts";

/** PC control tools whose media (screenshots) should not be shown in the chat UI */
export const PC_INTERNAL_MEDIA_TOOLS = new Set(["native__pc_do", "native__pc_observe"]);

type ToolResultContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string };

/** Match an http_fetch URL to a saved non-LLM credential by domain/type scoring. */
export function findCredentialForUrl(url: string): { id: string; name: string } | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const allSegments = hostname.split(".");
    // Only match against the registrable domain segments to prevent subdomain spoofing.
    // e.g. "github.evil.com" → registrable domain is "evil.com" → match only ["evil","com"]
    // "api.github.com" → registrable domain is "github.com" → match ["github","com"]
    // We use slice(-2) to approximate eTLD+1 (works for .com/.org/.io/.dev etc).
    // Note: this under-matches for country-code SLDs like .co.uk — acceptable trade-off.
    const domainSegments = allSegments.length > 2 ? allSegments.slice(-2) : allSegments;
    const creds = listCredentials().filter((c) => !LLM_CRED_TYPES.has(c.type));

    let best: { id: string; name: string; score: number } | null = null;

    for (const c of creds) {
      let score = 0;

      // Type-based matching (most reliable): "github" matches domain-level segment "github"
      const typeKey = c.type.replace(/-/g, "");
      if (domainSegments.some((seg) => seg === c.type || seg === typeKey)) {
        score += 10;
      }

      // Name keyword matching (exact segment only, no substring, domain-level only)
      const keywords = c.name
        .split(/[\s\-_.:]+/)
        .map((k) => k.toLowerCase())
        .filter((k) => k.length >= 3);
      for (const kw of keywords) {
        if (domainSegments.some((seg) => seg === kw)) score += 3;
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { id: c.id, name: c.name, score };
      }
    }

    return best && best.score >= 3 ? { id: best.id, name: best.name } : null;
  } catch {
    return null;
  }
}

/** Extract media artifacts from an MCP/native tool result that has a .content array */
export function extractMedia(rawResult: unknown, opts?: { internal?: boolean }): MediaArtifact[] {
  if (rawResult == null || typeof rawResult !== "object") return [];
  const obj = rawResult as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return [];

  const media: MediaArtifact[] = [];
  for (const item of obj.content) {
    if (
      item &&
      typeof item === "object" &&
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      try {
        const artifact = storeMediaFromBase64(item.data, item.mimeType);
        if (opts?.internal) artifact.internal = true;
        media.push(artifact);
      } catch (err) {
        console.error(
          "[media] failed to store artifact:",
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  return media;
}

/** Media safe to expose in chat/channel payloads. Internal screenshots stay LLM-only. */
export function publicMedia(media?: MediaArtifact[]): MediaArtifact[] {
  return media?.filter((m) => !m.internal) ?? [];
}

/**
 * Convert MCP/native .content arrays to AI SDK multipart tool-result content.
 * AI SDK v4 only forwards images to providers when they are in experimental_content.
 */
export function toolResultContentForLLM(
  rawResult: unknown,
  opts?: { includeImages?: boolean }
): ToolResultContentPart[] | undefined {
  if (rawResult == null || typeof rawResult !== "object") return undefined;
  const obj = rawResult as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return undefined;

  const content: ToolResultContentPart[] = [];
  for (const item of obj.content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
    } else if (
      opts?.includeImages &&
      part.type === "image" &&
      typeof part.data === "string"
    ) {
      content.push({
        type: "image",
        data: part.data,
        ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
      });
    }
  }

  return content.length > 0 ? content : undefined;
}

/** Strip base64 image data from tool results before sending back to LLM context. */
export function sanitizeResultForLLM(result: unknown, _media?: MediaArtifact[]): unknown {
  if (result == null || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return result;
  return {
    ...obj,
    content: (obj.content as Array<Record<string, unknown>>).map((item) => {
      if (item?.type !== "image") return item;
      const mimeLabel = typeof item.mimeType === "string" ? item.mimeType : "image";
      return {
        type: "text",
        text: `[image: ${mimeLabel}]`,
      };
    }),
  };
}

/** Summarize a tool result into a short human-readable string */
export function summarizeToolResult(result: unknown, media?: MediaArtifact[]): string {
  let text: string;
  if (result == null) text = "completed";
  else if (typeof result === "string") text = redactSensitiveData(result).slice(0, 200);
  else if (typeof result === "object" && "error" in (result as Record<string, unknown>)) {
    text = `error: ${redactSensitiveData(String((result as Record<string, unknown>).error))}`;
  } else {
    const json = redactSensitiveData(JSON.stringify(result));
    text = json.length > 200 ? json.slice(0, 200) + "…" : json;
  }

  if (media?.length) {
    const desc = media.map((m) => `[${m.mediaType}: ${m.filename ?? m.mimeType}]`).join(", ");
    text = text === "completed" ? desc : `${text} | ${desc}`;
  }
  return text;
}
