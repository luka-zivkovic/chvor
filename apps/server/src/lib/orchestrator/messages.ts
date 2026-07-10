import type { CoreMessage, FilePart, ImagePart, TextPart } from "ai";
import type { ChatMessage } from "@chvor/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMediaDir } from "../media-store.ts";

/**
 * Convert session ChatMessages to Vercel AI SDK CoreMessages.
 * Injects tool action annotations for assistant messages that used tools.
 * Constructs multimodal content blocks (ImagePart/FilePart) when user messages have media.
 */
export function sessionToMessages(messages: ChatMessage[]): CoreMessage[] {
  return messages
    .filter((m) => m.content.trim().length > 0 || (m.role === "user" && m.media?.length))
    .map((m) => {
      // User messages with media → multimodal content blocks
      if (m.role === "user" && m.media?.length) {
        const parts: Array<TextPart | ImagePart | FilePart> = [];

        for (const artifact of m.media) {
          try {
            const diskFile = artifact.url.replace("/api/media/", "");
            const filePath = join(getMediaDir(), diskFile);
            const data = readFileSync(filePath);

            if (artifact.mediaType === "image") {
              parts.push({ type: "image", image: data, mimeType: artifact.mimeType } as ImagePart);
            } else if (artifact.mediaType === "video" || artifact.mediaType === "audio") {
              parts.push({ type: "file", data, mimeType: artifact.mimeType } as FilePart);
            }
          } catch {
            // File missing on disk — skip this attachment
            parts.push({ type: "text", text: `[${artifact.mediaType}: ${artifact.filename ?? "unavailable"}]` });
          }
        }

        if (m.content.trim()) {
          parts.push({ type: "text", text: m.content });
        } else if (parts.length > 0 && !parts.some((p) => p.type === "text")) {
          parts.push({ type: "text", text: "What is this?" });
        }

        return { role: "user" as const, content: parts };
      }

      // Assistant messages with tool annotations
      let content = m.content;
      if (m.role === "assistant" && m.actions?.length) {
        const annotations = m.actions
          .map((a) => `[Tool: ${a.tool} → ${a.summary}]`)
          .join("\n");
        content = `${annotations}\n\n${content}`;
      }
      return { role: m.role, content };
    });
}
