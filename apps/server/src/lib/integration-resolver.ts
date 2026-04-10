/**
 * Three-tier integration resolver.
 *
 * Tier 1 — Provider Registry: checks hardcoded provider arrays.
 * Tier 2 — Chvor Registry: searches the registry index for tools with embedded credential schemas.
 * Returns null if not found — the caller is responsible for Tier 3 (AI research).
 */

import type { IntegrationResolution, ProviderField, RegistryEntry } from "@chvor/shared";
import {
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  INTEGRATION_PROVIDERS,
  IMAGE_GEN_PROVIDERS,
} from "./provider-registry.ts";
import { fetchRegistryIndex, readCachedIndex } from "./registry-client.ts";
import { readLock } from "./registry-manager.ts";
import { listCredentials } from "../db/credential-store.ts";

// ── Types for untyped registry credential blocks ───────────────

interface RegistryCredentialField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  helpText?: string;
}

interface RegistryCredentials {
  type: string;
  name: string;
  fields: RegistryCredentialField[];
}

type RegistryEntryWithCredentials = RegistryEntry & {
  credentials?: RegistryCredentials;
};

// ── Helpers ────────────────────────────────────────────────────

function mapRegistryField(f: RegistryCredentialField): ProviderField {
  const field: ProviderField = {
    key: f.key,
    label: f.label,
    type: f.secret ? "password" : "text",
  };
  if (f.required === false) {
    field.optional = true;
  }
  if (f.helpText) {
    field.helpText = f.helpText;
  }
  return field;
}

function findExistingCredential(credentialType: string): string | undefined {
  try {
    const creds = listCredentials();
    const match = creds.find((c) => c.type === credentialType);
    return match?.id;
  } catch {
    return undefined;
  }
}

// ── Tier 1: Provider Registry ──────────────────────────────────

function resolveFromProviderRegistry(query: string): IntegrationResolution | null {
  const q = query.toLowerCase();

  // Search LLM providers
  for (const p of LLM_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === q) {
      return {
        source: "provider-registry",
        name: p.name,
        credentialType: p.credentialType,
        fields: [...p.requiredFields],
      };
    }
  }

  // Search embedding providers (skip null credentialType)
  for (const p of EMBEDDING_PROVIDERS) {
    if (!p.credentialType) continue;
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === q) {
      // Embedding providers don't have requiredFields — return empty fields
      return {
        source: "provider-registry",
        name: p.name,
        credentialType: p.credentialType,
        fields: [],
      };
    }
  }

  // Search integration providers
  for (const p of INTEGRATION_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === q) {
      return {
        source: "provider-registry",
        name: p.name,
        credentialType: p.credentialType,
        fields: [...p.requiredFields],
      };
    }
  }

  // Search image-gen providers
  for (const p of IMAGE_GEN_PROVIDERS) {
    if (p.credentialType === query || p.id === query || p.name.toLowerCase() === q) {
      return {
        source: "provider-registry",
        name: p.name,
        credentialType: p.credentialType,
        fields: [],
      };
    }
  }

  return null;
}

// ── Tier 2: Chvor Registry ─────────────────────────────────────

async function getRegistryEntries(): Promise<RegistryEntryWithCredentials[]> {
  try {
    const index = await fetchRegistryIndex();
    return index.entries as RegistryEntryWithCredentials[];
  } catch {
    const cached = readCachedIndex();
    return (cached?.entries ?? []) as RegistryEntryWithCredentials[];
  }
}

function hasCredentials(entry: RegistryEntryWithCredentials): entry is RegistryEntryWithCredentials & { credentials: RegistryCredentials } {
  return (
    !!entry.credentials &&
    typeof entry.credentials.type === "string" &&
    Array.isArray(entry.credentials.fields)
  );
}

function resolveFromRegistryEntries(
  entries: RegistryEntryWithCredentials[],
  query: string,
  installedIds: Set<string>,
): IntegrationResolution | null {
  const q = query.toLowerCase();
  const withCreds = entries.filter(hasCredentials);

  // Exact matches: id, credentials.type, or name
  for (const entry of withCreds) {
    if (
      entry.id === query ||
      entry.credentials.type === query ||
      entry.name.toLowerCase() === q
    ) {
      return {
        source: "chvor-registry",
        name: entry.credentials.name,
        credentialType: entry.credentials.type,
        fields: entry.credentials.fields.map(mapRegistryField),
        registryEntryId: entry.id,
        registryToolInstalled: installedIds.has(entry.id),
      };
    }
  }

  // Fuzzy fallback: tags match, name includes query, description includes query
  for (const entry of withCreds) {
    const nameMatch = entry.name.toLowerCase().includes(q);
    const descMatch = entry.description.toLowerCase().includes(q);
    const tagMatch = entry.tags?.some((t) => t.toLowerCase() === q) ?? false;

    if (tagMatch || nameMatch || descMatch) {
      return {
        source: "chvor-registry",
        name: entry.credentials.name,
        credentialType: entry.credentials.type,
        fields: entry.credentials.fields.map(mapRegistryField),
        registryEntryId: entry.id,
        registryToolInstalled: installedIds.has(entry.id),
      };
    }
  }

  return null;
}

// ── Public API ─────────────────────────────────────────────────

export async function resolveIntegration(query: string): Promise<IntegrationResolution | null> {
  // Tier 1: Provider Registry
  const tier1 = resolveFromProviderRegistry(query);
  if (tier1) {
    tier1.existingCredentialId = findExistingCredential(tier1.credentialType);
    return tier1;
  }

  // Tier 2: Chvor Registry
  const entries = await getRegistryEntries();
  const lock = readLock();
  const installedIds = new Set(Object.keys(lock.installed));
  const tier2 = resolveFromRegistryEntries(entries, query, installedIds);
  if (tier2) {
    tier2.existingCredentialId = findExistingCredential(tier2.credentialType);
    return tier2;
  }

  // Not found — caller handles Tier 3
  return null;
}
