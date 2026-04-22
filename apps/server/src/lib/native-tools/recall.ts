import { tool } from "ai";
import { z } from "zod";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Memory: recall_detail
// ---------------------------------------------------------------------------

const RECALL_DETAIL_NAME = "native__recall_detail";

const recallDetailToolDef = tool({
  description:
    "[Recall Memory Detail] Retrieve the full detail (L1 overview + L2 narrative) of a memory. " +
    "Pass either the [mid:...] tag from your context or the abstract text.",
  parameters: z.object({
    memoryId: z
      .string()
      .optional()
      .describe("The memory ID prefix from a [mid:...] tag (e.g. 'abc12345'). Preferred over abstract search."),
    memoryAbstract: z
      .string()
      .optional()
      .describe("The abstract text of the memory. Used as fallback when memoryId is not available."),
  }),
});

const handleRecallDetail: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const { getRelevantMemoriesWithScores, findMemoryByIdPrefix } = await import("../../db/memory-store.ts");
  const memoryIdPrefix = String(args.memoryId ?? "").trim();
  const abstract = String(args.memoryAbstract ?? "").trim();

  if (!memoryIdPrefix && !abstract) {
    return { content: [{ type: "text", text: "Please provide a memoryId (from [mid:...] tag) or memoryAbstract." }] };
  }

  let best: import("@chvor/shared").Memory | undefined;

  // Prefer ID-based lookup (indexed LIKE query, not full table scan)
  if (memoryIdPrefix) {
    best = findMemoryByIdPrefix(memoryIdPrefix) ?? undefined;
  }

  // Fallback to vector search if ID lookup fails
  if (!best && abstract) {
    const results = await getRelevantMemoriesWithScores(abstract, 3);
    if (results.length > 0) {
      best = results[0].memory;
    }
  }

  if (!best) {
    return { content: [{ type: "text", text: "No matching memory found." }] };
  }
  const parts: string[] = [`**${best.abstract}**`];
  parts.push(`Category: ${best.category} | Confidence: ${Math.round(best.confidence * 100)}% | Strength: ${Math.round(best.strength * 100)}%`);

  if (best.overview) {
    parts.push(`\n**Overview:**\n${best.overview}`);
  }
  if (best.detail) {
    parts.push(`\n**Detail:**\n${best.detail}`);
  }
  if (!best.overview && !best.detail) {
    parts.push("\n(No additional detail available for this memory.)");
  }

  return {
    content: [{ type: "text", text: parts.join("\n") }],
  };
};

export const recallModule: NativeToolModule = {
  defs: { [RECALL_DETAIL_NAME]: recallDetailToolDef },
  handlers: { [RECALL_DETAIL_NAME]: handleRecallDetail },
};
