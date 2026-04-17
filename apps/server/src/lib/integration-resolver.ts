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
import { loadTools } from "./capability-loader.ts";

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
  } catch (err) {
    console.warn("[integration-resolver] findExistingCredential failed:", err instanceof Error ? err.message : String(err));
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
  } catch (err) {
    console.warn("[integration-resolver] fetchRegistryIndex failed, using cache:", err instanceof Error ? err.message : String(err));
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

function hasRequiresCredentials(entry: RegistryEntryWithCredentials): boolean {
  return !!entry.requires?.credentials?.length;
}

function getRequiresCredentials(entry: RegistryEntryWithCredentials): string[] {
  return entry.requires?.credentials ?? [];
}

/** Look up credential fields from the provider registry by credential type name. */
function deriveFieldsFromProviderRegistry(credType: string): ProviderField[] {
  const allProviders = [...LLM_PROVIDERS, ...INTEGRATION_PROVIDERS, ...IMAGE_GEN_PROVIDERS];
  for (const p of allProviders) {
    if (p.credentialType === credType) {
      return [...(p as { requiredFields?: ProviderField[] }).requiredFields ?? []];
    }
  }
  return [{ key: "apiKey", label: "API Key", type: "password" }];
}

function buildResolutionFromEntry(
  entry: RegistryEntryWithCredentials,
  installedIds: Set<string>,
): IntegrationResolution | null {
  // Prefer full credentials block when available
  if (hasCredentials(entry)) {
    return {
      source: "chvor-registry",
      name: entry.credentials.name,
      credentialType: entry.credentials.type,
      fields: entry.credentials.fields.map(mapRegistryField),
      registryEntryId: entry.id,
      registryToolInstalled: installedIds.has(entry.id),
    };
  }

  // Fallback: derive from requires.credentials names
  if (hasRequiresCredentials(entry)) {
    const credType = getRequiresCredentials(entry)[0];
    const fields = deriveFieldsFromProviderRegistry(credType);
    return {
      source: "chvor-registry",
      name: entry.name,
      credentialType: credType,
      fields,
      registryEntryId: entry.id,
      registryToolInstalled: installedIds.has(entry.id),
    };
  }

  return null;
}

function resolveFromRegistryEntries(
  entries: RegistryEntryWithCredentials[],
  query: string,
  installedIds: Set<string>,
): IntegrationResolution | null {
  const q = query.toLowerCase();
  const withCreds = entries.filter((e) => hasCredentials(e) || hasRequiresCredentials(e));

  // Exact matches: id, credentials.type, requires.credentials, or name
  for (const entry of withCreds) {
    const credType = hasCredentials(entry)
      ? entry.credentials.type
      : getRequiresCredentials(entry)[0];

    if (
      entry.id === query ||
      credType === query ||
      entry.name.toLowerCase() === q
    ) {
      return buildResolutionFromEntry(entry, installedIds);
    }
  }

  // Fuzzy fallback: tags match, name includes query, description includes query
  for (const entry of withCreds) {
    const nameMatch = entry.name.toLowerCase().includes(q);
    const descMatch = entry.description.toLowerCase().includes(q);
    const tagMatch = entry.tags?.some((t) => t.toLowerCase() === q) ?? false;

    if (tagMatch || nameMatch || descMatch) {
      return buildResolutionFromEntry(entry, installedIds);
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

  // Tier 2b: Check installed tools' credentialSchema from frontmatter
  const q = query.toLowerCase();
  for (const tool of loadTools()) {
    const schema = tool.metadata.credentialSchema;
    if (!schema) continue;
    if (
      tool.id === query ||
      schema.type === query ||
      tool.metadata.name.toLowerCase() === q ||
      tool.metadata.name.toLowerCase().includes(q)
    ) {
      const resolution: IntegrationResolution = {
        source: "chvor-registry",
        name: schema.name,
        credentialType: schema.type,
        fields: schema.fields.map(mapRegistryField),
        registryEntryId: tool.id,
        registryToolInstalled: installedIds.has(tool.id),
      };
      resolution.existingCredentialId = findExistingCredential(schema.type);
      return resolution;
    }
  }

  // Not found — caller handles Tier 3
  return null;
}
