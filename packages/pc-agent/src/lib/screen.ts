import screenshot from "screenshot-desktop";
import sharp from "sharp";

/** Max target resolution for AI computer use. Preserve aspect ratio; never letterbox. */
export const TARGET_WIDTH = 1024;
export const TARGET_HEIGHT = 768;

let cachedScreenSize: { width: number; height: number } | null = null;

export interface CoordinateSpace {
  /** Image/coordinate-space width after aspect-preserving downscale. */
  width: number;
  /** Image/coordinate-space height after aspect-preserving downscale. */
  height: number;
  /** Native source width before resizing. */
  sourceWidth: number;
  /** Native source height before resizing. */
  sourceHeight: number;
  /** X scale from native source pixels to coordinate-space pixels. */
  scaleX: number;
  /** Y scale from native source pixels to coordinate-space pixels. */
  scaleY: number;
}

/**
 * Compute the screenshot coordinate space used by the AI.
 *
 * Older versions forced every screenshot into 1024x768 with `fit: contain`,
 * creating black bars on widescreen displays while input mapping still assumed
 * the whole image represented the screen. This helper preserves aspect ratio
 * and returns the actual image dimensions the model will see.
 */
export function computeCoordinateSpace(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = TARGET_WIDTH,
  maxHeight = TARGET_HEIGHT
): CoordinateSpace {
  const safeSourceWidth = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 1920;
  const safeSourceHeight = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 1080;
  const scale = Math.min(1, maxWidth / safeSourceWidth, maxHeight / safeSourceHeight);
  const width = Math.max(1, Math.round(safeSourceWidth * scale));
  const height = Math.max(1, Math.round(safeSourceHeight * scale));

  return {
    width,
    height,
    sourceWidth: safeSourceWidth,
    sourceHeight: safeSourceHeight,
    scaleX: width / safeSourceWidth,
    scaleY: height / safeSourceHeight,
  };
}

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
  /** Width/height of the encoded image returned to the model/UI. */
  width: number;
  height: number;
  /** Native captured desktop size before resizing. */
  sourceWidth: number;
  sourceHeight: number;
  /** Native-to-returned-image scale factors. */
  scaleX: number;
  scaleY: number;
  mimeType: "image/jpeg" | "image/png";
}

export async function captureScreen(opts?: {
  format?: "jpeg" | "png";
  quality?: number;
}): Promise<CapturedScreenshot> {
  const format = opts?.format ?? "jpeg";
  const quality = opts?.quality ?? 80;

  const buf = await screenshot({ format: "png" });
  const meta = await sharp(buf).metadata();
  const sourceWidth = meta.width ?? TARGET_WIDTH;
  const sourceHeight = meta.height ?? TARGET_HEIGHT;
  const space = computeCoordinateSpace(sourceWidth, sourceHeight);

  // Downscale to the AI coordinate space and compress. The resize is exact
  // because computeCoordinateSpace already preserves aspect ratio.
  let pipeline = sharp(buf);
  if (space.width !== sourceWidth || space.height !== sourceHeight) {
    pipeline = pipeline.resize(space.width, space.height, { fit: "fill" });
  }

  let resized: Buffer;
  if (format === "jpeg") {
    resized = await pipeline.jpeg({ quality }).toBuffer();
  } else {
    resized = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  }

  return {
    data: resized.toString("base64"),
    width: space.width,
    height: space.height,
    sourceWidth: space.sourceWidth,
    sourceHeight: space.sourceHeight,
    scaleX: space.scaleX,
    scaleY: space.scaleY,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}
