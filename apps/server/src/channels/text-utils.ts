/**
 * Split text into chunks that respect a maximum length, preferring to split at newlines.
 * Shared across all channel adapters to avoid duplication.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (maxLen <= 0) return [text];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < 0) splitAt = maxLen; // was <= 0, which skipped valid split at position 0
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
