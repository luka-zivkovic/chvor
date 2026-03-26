/**
 * Lightweight DOCX text extraction.
 * DOCX files are ZIP archives containing word/document.xml.
 * We extract the XML and strip tags, preserving paragraph breaks.
 */

import AdmZip from "adm-zip";

export function extractDocxText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry("word/document.xml");
  if (!entry) {
    throw new Error("Invalid DOCX: missing word/document.xml");
  }

  const MAX_DECOMPRESSED = 50 * 1024 * 1024; // 50 MB
  // Check reported uncompressed size before decompressing to guard against zip bombs
  if (entry.header.size > MAX_DECOMPRESSED) {
    throw new Error(`DOCX document.xml too large (reported ${entry.header.size} bytes, max ${MAX_DECOMPRESSED})`);
  }
  const raw = entry.getData();
  if (raw.length > MAX_DECOMPRESSED) {
    throw new Error(`DOCX document.xml too large after decompression (${raw.length} bytes)`);
  }
  const xml = raw.toString("utf-8");

  // Replace paragraph and line break tags with newlines
  let text = xml
    .replace(/<\/w:p[^>]*>/gi, "\n")
    .replace(/<w:br[^>]*\/>/gi, "\n")
    .replace(/<w:tab[^>]*\/>/gi, "\t");

  // Strip all remaining XML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode basic XML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}
