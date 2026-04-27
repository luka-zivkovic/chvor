import type {
  ModelRole,
  ModelRoleConfig,
  ModelRolesConfig,
  RoleFallbackEntry,
  EmbeddingConfig,
} from "@chvor/shared";
import { getDb } from "../database.ts";
import { getConfig, setConfig } from "./base.ts";

// --- LLM preference ---

export interface LLMPreference {
  providerId: string;
  model: string;
}

export function getLLMPreference(): LLMPreference | null {
  const providerId = getConfig("llm.providerId");
  const model = getConfig("llm.model");
  if (!providerId || !model) return null;
  return { providerId, model };
}

export function setLLMPreference(providerId: string, model: string): LLMPreference {
  setConfig("llm.providerId", providerId);
  setConfig("llm.model", model);
  return { providerId, model };
}

// --- Model role config ---

export function getRoleConfig(role: ModelRole): ModelRoleConfig | null {
  const providerId = getConfig(`llm.role.${role}.providerId`);
  const model = getConfig(`llm.role.${role}.model`);

  // Migration: if primary has no role config but legacy keys exist, use those
  if (!providerId && role === "primary") {
    const legacy = getLLMPreference();
    if (legacy) {
      // Persist migration
      setRoleConfig("primary", legacy.providerId, legacy.model);
      return legacy;
    }
  }

  if (!providerId || !model) return null;
  return { providerId, model };
}

export function setRoleConfig(role: ModelRole, providerId: string, model: string): ModelRoleConfig {
  setConfig(`llm.role.${role}.providerId`, providerId);
  setConfig(`llm.role.${role}.model`, model);
  // Keep legacy keys in sync for primary
  if (role === "primary") {
    setLLMPreference(providerId, model);
  }
  return { providerId, model };
}

export function clearRoleConfig(role: ModelRole): void {
  const db = getDb();
  db.prepare("DELETE FROM config WHERE key = ?").run(`llm.role.${role}.providerId`);
  db.prepare("DELETE FROM config WHERE key = ?").run(`llm.role.${role}.model`);
}

export function getAllRoleConfigs(): ModelRolesConfig {
  return {
    primary: getRoleConfig("primary"),
    reasoning: getRoleConfig("reasoning"),
    lightweight: getRoleConfig("lightweight"),
    heartbeat: getRoleConfig("heartbeat"),
  };
}

// --- Model fallback chains ---

export function getRoleFallbacks(role: ModelRole): RoleFallbackEntry[] {
  const raw = getConfig(`llm.role.${role}.fallbacks`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function setRoleFallbacks(role: ModelRole, fallbacks: RoleFallbackEntry[]): void {
  setConfig(`llm.role.${role}.fallbacks`, JSON.stringify(fallbacks));
}

export function getAllRoleFallbacks(): Record<string, RoleFallbackEntry[]> {
  const roles: ModelRole[] = ["primary", "reasoning", "lightweight", "heartbeat"];
  const result: Record<string, RoleFallbackEntry[]> = {};
  for (const role of roles) {
    result[role] = getRoleFallbacks(role);
  }
  return result;
}

// --- Embedding preference ---

export function getEmbeddingPreference(): EmbeddingConfig {
  return {
    providerId: getConfig("embedding.providerId") ?? "local",
    model: getConfig("embedding.model") ?? "Xenova/all-MiniLM-L6-v2",
    dimensions: (() => { const v = parseInt(getConfig("embedding.dimensions") ?? "384", 10); return Number.isNaN(v) ? 384 : v; })(),
  };
}

export function setEmbeddingPreference(pref: EmbeddingConfig): EmbeddingConfig {
  setConfig("embedding.providerId", pref.providerId);
  setConfig("embedding.model", pref.model);
  setConfig("embedding.dimensions", String(pref.dimensions));
  return pref;
}
