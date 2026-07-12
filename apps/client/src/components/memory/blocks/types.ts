import type { MemoryBlockRecord } from "@chvor/shared";
import { api } from "../../../lib/api";

export const memoryBlocksApi = api.memoryBlocks;

export interface ConflictInfo {
  expectedRevision: number;
  actualRevision: number | null;
  latestLoaded: boolean;
}

export type MutationResult =
  | { kind: "updated"; record: MemoryBlockRecord }
  | { kind: "conflict"; latest: MemoryBlockRecord };
