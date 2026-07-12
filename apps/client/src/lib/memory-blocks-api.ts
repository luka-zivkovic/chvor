import type {
  MemoryBlockCreateRequest,
  MemoryBlockPage,
  MemoryBlockRecord,
  MemoryBlockRestoreRequest,
  MemoryBlockRevisionPage,
  MemoryBlockUpdateRequest,
} from "@chvor/shared";

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface MemoryBlockPageOptions {
  limit?: number;
  cursor?: string;
}

function pageQuery(options: MemoryBlockPageOptions): string {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function createMemoryBlocksApi(request: JsonRequest) {
  return {
    list: (options: MemoryBlockPageOptions = {}) =>
      request<MemoryBlockPage>(`/memory-blocks${pageQuery(options)}`),

    get: (id: string) =>
      request<{ memoryBlock: MemoryBlockRecord }>(`/memory-blocks/${encodeURIComponent(id)}`).then(
        ({ memoryBlock }) => memoryBlock
      ),

    create: (body: MemoryBlockCreateRequest) =>
      request<{ memoryBlock: MemoryBlockRecord }>("/memory-blocks", {
        method: "POST",
        body: JSON.stringify(body),
      }).then(({ memoryBlock }) => memoryBlock),

    update: (id: string, body: MemoryBlockUpdateRequest) =>
      request<{ memoryBlock: MemoryBlockRecord }>(`/memory-blocks/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }).then(({ memoryBlock }) => memoryBlock),

    revisions: (id: string, options: MemoryBlockPageOptions = {}) =>
      request<MemoryBlockRevisionPage>(
        `/memory-blocks/${encodeURIComponent(id)}/revisions${pageQuery(options)}`
      ),

    restore: (id: string, body: MemoryBlockRestoreRequest) =>
      request<{ memoryBlock: MemoryBlockRecord }>(
        `/memory-blocks/${encodeURIComponent(id)}/restore`,
        { method: "POST", body: JSON.stringify(body) }
      ).then(({ memoryBlock }) => memoryBlock),
  };
}
