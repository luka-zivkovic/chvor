/**
 * Dynamic model metadata populated from provider API responses.
 * Kept separate from the frozen static maps in provider-registry
 * to avoid mutation and circular imports.
 */

const dynamicContextWindows = new Map<string, number>();
const dynamicMaxTokens = new Map<string, number>();

export function setDynamicContextWindow(modelId: string, value: number): void {
  if (!dynamicContextWindows.has(modelId)) {
    dynamicContextWindows.set(modelId, value);
  }
}

export function setDynamicMaxTokens(modelId: string, value: number): void {
  if (!dynamicMaxTokens.has(modelId)) {
    dynamicMaxTokens.set(modelId, value);
  }
}

export function getDynamicContextWindow(modelId: string): number | undefined {
  return dynamicContextWindows.get(modelId);
}

export function getDynamicMaxTokens(modelId: string): number | undefined {
  return dynamicMaxTokens.get(modelId);
}
