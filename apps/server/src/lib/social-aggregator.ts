/**
 * Aggregates social connections from all providers (Composio OAuth + custom MCP tools).
 * Provides a unified view for the social:list capability.
 */

import { getCapabilityRegistry } from "./capability-resolver.ts";

export interface AggregatedConnection {
  platform: string;
  provider: string;
  providerType: "composio" | "mcp";
  status: string;
  connectedAt?: string;
  id?: string;
  capabilities?: string[];
}

// Social platform namespaces that indicate a platform connection
const SOCIAL_PLATFORMS = new Set([
  "twitter", "linkedin", "reddit", "instagram", "facebook",
  "youtube", "tiktok", "discord", "telegram", "bluesky",
  "mastodon", "pinterest", "threads", "whatsapp", "slack",
  "medium", "wordpress", "ghost",
]);

/**
 * List all social connections across Composio and custom MCP providers.
 */
export async function listAllSocialConnections(
  platform?: string,
): Promise<AggregatedConnection[]> {
  const connections: AggregatedConnection[] = [];

  // 1. Composio OAuth connections
  try {
    const { listConnectedAccounts } = await import("./composio-client.ts");
    const composioAccounts = await listConnectedAccounts(platform);
    for (const account of composioAccounts) {
      connections.push({
        platform: account.platform,
        provider: "Composio",
        providerType: "composio",
        status: account.status,
        connectedAt: account.connectedAt,
        id: account.id,
      });
    }
  } catch (err) {
    // Only silence "no API key" — log real errors
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("API key") && !msg.includes("not configured")) {
      console.warn("[social-aggregator] Composio error:", msg);
    }
  }

  // 2. Custom MCP tool connections (non-Composio providers)
  const registry = getCapabilityRegistry();
  const mcpPlatforms = new Map<string, { toolId: string; capabilities: string[] }>();

  for (const [capId, providers] of registry) {
    const [capPlatform] = capId.split(":");
    if (!capPlatform || !SOCIAL_PLATFORMS.has(capPlatform)) continue;
    if (platform && capPlatform !== platform) continue;

    for (const provider of providers) {
      // Skip native tools and composio (already handled above)
      if (provider.toolId === "native" || provider.toolId === "composio") continue;

      const existing = mcpPlatforms.get(`${capPlatform}:${provider.toolId}`);
      if (existing) {
        existing.capabilities.push(capId);
      } else {
        mcpPlatforms.set(`${capPlatform}:${provider.toolId}`, {
          toolId: provider.toolId,
          capabilities: [capId],
        });
      }
    }
  }

  for (const [key, info] of mcpPlatforms) {
    const [capPlatform] = key.split(":");
    connections.push({
      platform: capPlatform,
      provider: info.toolId,
      providerType: "mcp",
      status: "connected",
      capabilities: info.capabilities,
    });
  }

  return connections;
}
