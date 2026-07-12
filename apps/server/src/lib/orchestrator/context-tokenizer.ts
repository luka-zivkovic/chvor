import type { ContextTokenizer } from "@chvor/shared";

/**
 * Conservative provider-independent profile used until a native tokenizer is
 * registered. One UTF-8 byte is charged as one token, which is an upper bound
 * for byte-pair tokenizers and therefore never grants optimistic capacity.
 */
export function createContextTokenizer(providerId: string, modelId: string): ContextTokenizer {
  const modelKey = `${providerId}/${modelId}`.normalize("NFC");
  return {
    id: `chvor:utf8-byte-upper-bound:${modelKey}`,
    version: "1",
    countTokens(text: string): number {
      return new TextEncoder().encode(text).byteLength;
    },
  };
}
