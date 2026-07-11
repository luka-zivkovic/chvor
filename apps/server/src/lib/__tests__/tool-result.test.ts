import { describe, expect, it } from "vitest";
import type { MediaArtifact } from "@chvor/shared";
import {
  publicMedia,
  sanitizeResultForLLM,
  sanitizeResultForTrajectory,
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

  it("makes trajectory output JSON-safe, bounded, and redacted", () => {
    const cyclic: Record<string, unknown> = {
      password: "do-not-persist",
      count: 12n,
      bytes: new Uint8Array([1, 2, 3]),
    };
    cyclic.self = cyclic;

    expect(sanitizeResultForTrajectory(cyclic)).toEqual({
      password: "[REDACTED]",
      count: "12",
      bytes: "[binary 3 bytes]",
      self: "[Circular]",
    });
    expect(sanitizeResultForTrajectory(imageResult)).toEqual({
      content: [
        { type: "text", text: "Screenshot taken." },
        { type: "text", text: "[image: image/jpeg]" },
      ],
    });

    const oversized = sanitizeResultForTrajectory({ text: "x".repeat(100_000) }) as {
      text: string;
    };
    expect(Buffer.byteLength(oversized.text)).toBeLessThanOrEqual(64_000);
    expect(oversized.text).toMatch(/\[TRUNCATED\]$/);
    const oversizedCollection = sanitizeResultForTrajectory(
      Array.from({ length: 25_000 }, (_, index) => index)
    ) as unknown[];
    expect(oversizedCollection.length).toBeLessThanOrEqual(20_000);
  });

  it("never persists raw output from credential-reveal tools", () => {
    const opaqueSecret = "opaque-value-with-no-recognizable-token-pattern";
    const safe = sanitizeResultForTrajectory(
      { content: [{ type: "text", text: JSON.stringify({ "X-API-Key": opaqueSecret }) }] },
      undefined,
      "native__use_credential"
    );

    expect(safe).toEqual({
      content: [{ type: "text", text: "Credential retrieved." }],
    });
    expect(JSON.stringify(safe)).not.toContain(opaqueSecret);
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
