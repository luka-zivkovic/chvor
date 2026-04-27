import type { BrainConfig, UpdateBrainConfigRequest } from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// --- Brain config ---

export function getBrainConfig(): BrainConfig {
  return {
    maxToolRounds: parseInt(getConfig("brain.maxToolRounds") ?? "30", 10) || 30,
    // Default 1: extract memories every turn for higher recall quality (was 3; reverted for responsiveness)
    memoryBatchSize: parseInt(getConfig("brain.memoryBatchSize") ?? "1", 10) || 1,
    lowTokenMode: (getConfig("brain.lowTokenMode") ?? "false") === "true",
  };
}

// --- Self-Healing config ---

export function getSelfHealingEnabled(): boolean {
  return (getConfig("selfHealing.enabled") ?? "true") === "true";
}

export function setSelfHealingEnabled(enabled: boolean): boolean {
  setConfig("selfHealing.enabled", String(enabled));
  return enabled;
}

// --- PC Control config ---

export function getPcControlEnabled(): boolean {
  return (getConfig("pcControl.enabled") ?? "true") === "true";
}

export function setPcControlEnabled(enabled: boolean): boolean {
  setConfig("pcControl.enabled", String(enabled));
  return enabled;
}

export function updateBrainConfig(updates: UpdateBrainConfigRequest): BrainConfig {
  if (updates.maxToolRounds !== undefined) {
    const clamped = Math.max(1, Math.min(100, Math.floor(updates.maxToolRounds)));
    setConfig("brain.maxToolRounds", String(clamped));
  }
  if (updates.memoryBatchSize !== undefined) {
    const clamped = Math.max(1, Math.min(20, Math.floor(updates.memoryBatchSize)));
    setConfig("brain.memoryBatchSize", String(clamped));
  }
  if (updates.lowTokenMode !== undefined) {
    setConfig("brain.lowTokenMode", String(updates.lowTokenMode));
  }
  return getBrainConfig();
}

// --- Cognitive Memory config ---

export interface CognitiveMemoryConfig {
  decayEnabled: boolean;
  consolidationEnabled: boolean;
  preloadingEnabled: boolean;
  strengthThreshold: number;
  maxRetrievalCount: number;
}

export function getCognitiveMemoryConfig(): CognitiveMemoryConfig {
  return {
    decayEnabled: (getConfig("memory.decayEnabled") ?? "true") === "true",
    consolidationEnabled: (getConfig("memory.consolidationEnabled") ?? "true") === "true",
    preloadingEnabled: (getConfig("memory.preloadingEnabled") ?? "true") === "true",
    strengthThreshold: (() => { const v = parseFloat(getConfig("memory.strengthThreshold") ?? ""); return Number.isNaN(v) ? 0.05 : v; })(),
    maxRetrievalCount: (() => { const v = parseInt(getConfig("memory.maxRetrievalCount") ?? "", 10); return Number.isNaN(v) ? 20 : v; })(),
  };
}

export function updateCognitiveMemoryConfig(updates: Partial<CognitiveMemoryConfig>): CognitiveMemoryConfig {
  if (updates.decayEnabled !== undefined) setConfig("memory.decayEnabled", String(updates.decayEnabled));
  if (updates.consolidationEnabled !== undefined) setConfig("memory.consolidationEnabled", String(updates.consolidationEnabled));
  if (updates.preloadingEnabled !== undefined) setConfig("memory.preloadingEnabled", String(updates.preloadingEnabled));
  if (updates.strengthThreshold !== undefined) {
    setConfig("memory.strengthThreshold", String(Math.max(0, Math.min(1, updates.strengthThreshold))));
  }
  if (updates.maxRetrievalCount !== undefined) {
    setConfig("memory.maxRetrievalCount", String(Math.max(1, Math.min(50, Math.floor(updates.maxRetrievalCount)))));
  }
  return getCognitiveMemoryConfig();
}
