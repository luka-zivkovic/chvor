/**
 * Capability Resolution System
 *
 * Maps abstract capability IDs (e.g. "twitter:post") to concrete qualified
 * tool names (e.g. "composio__TWITTER_CREATE_TWEET"). Skills use {{cap:...}}
 * syntax in their markdown; this module resolves them before prompt assembly.
 */

import type { Tool } from "@chvor/shared";
import { mapComposioToolName } from "./composio-capability-map.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityProvider {
  capabilityId: string;
  qualifiedToolName: string;
  toolId: string;
  priority: number;
}

export interface CapabilityResolution {
  capabilityId: string;
  resolved: boolean;
  qualifiedToolName?: string;
  fallbackMessage?: string;
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const registry = new Map<string, CapabilityProvider[]>();

// Priority constants
const PRIORITY_NATIVE = 10;
const PRIORITY_EXPLICIT = 5;
const PRIORITY_AUTO_MAPPED = 1;

// ---------------------------------------------------------------------------
// Native tool capability declarations
// ---------------------------------------------------------------------------

const NATIVE_CAPABILITIES: Record<string, string> = {
  "native__social_connect": "social:connect",
  "native__social_list": "social:list",
  "native__social_disconnect": "social:disconnect",
};

// ---------------------------------------------------------------------------
// Registry building
// ---------------------------------------------------------------------------

function registerProvider(provider: CapabilityProvider): void {
  const existing = registry.get(provider.capabilityId) ?? [];
  existing.push(provider);
  // Sort descending by priority (highest first)
  existing.sort((a, b) => b.priority - a.priority);
  registry.set(provider.capabilityId, existing);
}

/**
 * Build the capability registry from discovered MCP tools and native tools.
 * Call this after buildToolDefinitions() discovers MCP tools.
 */
export function buildCapabilityRegistry(
  tools: Tool[],
  discoveredMcpTools: Map<string, McpToolInfo[]>,
): void {
  // Only clear capabilities for tools that were actually re-discovered.
  // Preserve existing entries for tools that failed discovery (transient errors)
  // so skills don't lose capability resolution during temporary MCP failures.
  const discoveredToolIds = new Set(discoveredMcpTools.keys());
  for (const [capId, providers] of registry) {
    const remaining = providers.filter(
      (p) => p.toolId === "native" || !discoveredToolIds.has(p.toolId)
    );
    if (remaining.length > 0) {
      registry.set(capId, remaining);
    } else {
      registry.delete(capId);
    }
  }

  // 1. Register native tool capabilities
  for (const [nativeToolName, capId] of Object.entries(NATIVE_CAPABILITIES)) {
    registerProvider({
      capabilityId: capId,
      qualifiedToolName: nativeToolName,
      toolId: "native",
      priority: PRIORITY_NATIVE,
    });
  }

  // 2. Register MCP tool capabilities
  for (const tool of tools) {
    const mcpTools = discoveredMcpTools.get(tool.id);
    if (!mcpTools) continue;

    for (const mcpTool of mcpTools) {
      const qualifiedName = `${tool.id}__${mcpTool.name}`;

      // 2a. Check explicit `provides` in tool frontmatter
      if (tool.metadata.provides) {
        for (const [capId, mcpName] of Object.entries(tool.metadata.provides)) {
          if (mcpName === mcpTool.name) {
            registerProvider({
              capabilityId: capId,
              qualifiedToolName: qualifiedName,
              toolId: tool.id,
              priority: PRIORITY_EXPLICIT,
            });
          }
        }
      }

      // 2b. Auto-map Composio tools via convention parser
      if (tool.id === "composio") {
        const capId = mapComposioToolName(mcpTool.name);
        if (capId) {
          // Only register if not already explicitly provided (avoid duplicates)
          const existing = registry.get(capId);
          const alreadyHasThis = existing?.some((p) => p.qualifiedToolName === qualifiedName);
          if (!alreadyHasThis) {
            registerProvider({
              capabilityId: capId,
              qualifiedToolName: qualifiedName,
              toolId: tool.id,
              priority: PRIORITY_AUTO_MAPPED,
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single capability ID to its best provider.
 */
export function resolveCapability(capabilityId: string): CapabilityResolution {
  const providers = registry.get(capabilityId);
  if (!providers || providers.length === 0) {
    const [platform, action] = capabilityId.split(":");
    const platformName = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "Unknown";
    const actionName = action ?? "action";
    return {
      capabilityId,
      resolved: false,
      fallbackMessage: `[${platformName} ${actionName} is not available — connect via social:connect or add a ${platformName} MCP tool]`,
    };
  }

  return {
    capabilityId,
    resolved: true,
    qualifiedToolName: providers[0].qualifiedToolName,
  };
}

// ---------------------------------------------------------------------------
// {{cap:...}} substitution in skill instruction text
// ---------------------------------------------------------------------------

const CAP_REF_RE = /\{\{cap:([a-z][a-z0-9]*:[a-z][a-z0-9-]*)\}\}/g;

/**
 * Resolve all {{cap:...}} references in a text string.
 * Replaces with concrete tool names or human-readable fallback messages.
 */
export function resolveCapabilityReferences(text: string): string {
  if (!text.includes("{{cap:")) return text;

  return text.replace(CAP_REF_RE, (_match, capId: string) => {
    const resolution = resolveCapability(capId);
    if (resolution.resolved && resolution.qualifiedToolName) {
      return `\`${resolution.qualifiedToolName}\``;
    }
    return resolution.fallbackMessage ?? `[${capId} — not available]`;
  });
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/**
 * Invalidate the capability registry. Call alongside invalidateToolCache().
 */
export function invalidateCapabilityRegistry(): void {
  registry.clear();
}

/**
 * Get all registered capabilities (for debugging / diagnostics).
 */
export function getCapabilityRegistry(): Map<string, CapabilityProvider[]> {
  return registry;
}
