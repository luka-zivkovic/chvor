import screenshot from "screenshot-desktop";
import sharp from "sharp";

/** Target resolution for Claude's computer use (Anthropic recommendation) */
export const TARGET_WIDTH = 1024;
export const TARGET_HEIGHT = 768;

let cachedScreenSize: { width: number; height: number } | null = null;

export async function getScreenSize(): Promise<{ width: number; height: number }> {
  if (cachedScreenSize) return cachedScreenSize;

  // Take a test screenshot to determine native resolution
  const buf = await screenshot({ format: "png" });
  const meta = await sharp(buf).metadata();
  cachedScreenSize = {
    width: meta.width ?? 1920,
    height: meta.height ?? 1080,
  };
  return cachedScreenSize;
}

export interface CapturedScreenshot {
  /** Base64-encoded image data */
  data: string;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
}

export async function captureScreen(opts?: {
  format?: "jpeg" | "png";
  quality?: number;
}): Promise<CapturedScreenshot> {
  const format = opts?.format ?? "jpeg";
  const quality = opts?.quality ?? 80;

  const buf = await screenshot({ format: "png" });

  // Resize to target resolution and compress
  const pipeline = sharp(buf).resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } });

  let resized: Buffer;
  if (format === "jpeg") {
    resized = await pipeline.jpeg({ quality }).toBuffer();
  } else {
    resized = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  }

  return {
    data: resized.toString("base64"),
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}
