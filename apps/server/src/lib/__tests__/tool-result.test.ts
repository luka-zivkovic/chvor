import { describe, expect, it } from "vitest";
import type { MediaArtifact } from "@chvor/shared";
import {
  publicMedia,
  sanitizeResultForLLM,
  toolResultContentForLLM,
} from "../orchestrator/tool-result.ts";

describe("tool-result helpers", () => {
  const imageResult = {
    content: [
      { type: "text", text: "Screenshot taken." },
      { type: "image", data: "base64-screenshot", mimeType: "image/jpeg" },
    ],
  };

  it("strips image base64 and media filenames from sanitized tool results", () => {
    const media: MediaArtifact[] = [
      {
        id: "m1",
        url: "/api/media/internal-screenshot.jpg",
        mimeType: "image/jpeg",
        mediaType: "image",
        filename: "internal-screenshot.jpg",
        internal: true,
      },
    ];

    expect(sanitizeResultForLLM(imageResult, media)).toEqual({
      content: [
        { type: "text", text: "Screenshot taken." },
        { type: "text", text: "[image: image/jpeg]" },
      ],
    });
  });

  it("keeps image data only in AI SDK multipart tool-result content", () => {
    expect(toolResultContentForLLM(imageResult, { includeImages: true })).toEqual([
      { type: "text", text: "Screenshot taken." },
      { type: "image", data: "base64-screenshot", mimeType: "image/jpeg" },
    ]);
  });

  it("filters internal media from public surfaces", () => {
    const media: MediaArtifact[] = [
      {
        id: "internal",
        url: "/api/media/internal.png",
        mimeType: "image/png",
        mediaType: "image",
        internal: true,
      },
      {
        id: "public",
        url: "/api/media/public.png",
        mimeType: "image/png",
        mediaType: "image",
      },
    ];

    expect(publicMedia(media)).toEqual([media[1]]);
  });
});
