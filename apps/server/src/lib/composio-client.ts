/**
 * Composio SDK client — uses the official @composio/core SDK
 * for social account management (OAuth connections).
 */

import { Composio } from "@composio/core";
import { listCredentials, getCredentialData } from "../db/credential-store.ts";

const COMPOSIO_ENTITY_ID = "default"; // Chvor is single-user

export interface SocialAccount {
  id: string;
  platform: string;
  status: string;
  connectedAt: string;
}

function getComposioApiKey(): string | null {
  const creds = listCredentials();
  const composioCred = creds.find((c) => c.type === "composio");
  if (!composioCred) return null;

  const full = getCredentialData(composioCred.id);
  if (!full) return null;

  return (full.data as Record<string, string>).apiKey ?? null;
}

function getClient(): Composio {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    throw new Error(
      "No Composio API key found. Please add your Composio API key first.\n" +
        "You can get a free key at https://app.composio.dev/settings",
    );
  }
  return new Composio({ apiKey });
}

/**
 * Resolve the auth config ID for a given toolkit (e.g. "reddit").
 * Looks for a Composio-managed config first, falls back to any available config.
 */
async function resolveAuthConfigId(
  client: Composio,
  toolkit: string,
): Promise<string> {
  const configs = await client.authConfigs.list({ toolkit });
  const items = configs.items ?? [];

  if (items.length === 0) {
    throw new Error(
      `No auth config found for "${toolkit}" in Composio. ` +
        `Please create one at https://app.composio.dev or via the Composio dashboard.`,
    );
  }

  // Prefer Composio-managed config, otherwise use the first available
  const managed = items.find(
    (c: Record<string, unknown>) =>
      (c as { type?: string }).type === "COMPOSIO_MANAGED" ||
      (c as { isComposioManaged?: boolean }).isComposioManaged === true,
  );

  const config = managed ?? items[0];
  const id = (config as { id?: string }).id;
  if (!id) {
    throw new Error(
      `Auth config for "${toolkit}" is missing an ID. This may indicate an SDK version mismatch.`,
    );
  }
  return id;
}

/**
 * Initiate an OAuth connection for a given toolkit (e.g. "twitter", "reddit").
 * Returns a URL the user must visit to authorize.
 */
export async function initiateConnection(
  toolkit: string,
  redirectUrl?: string,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const client = getClient();
  const authConfigId = await resolveAuthConfigId(client, toolkit);

  const connectionRequest = await client.connectedAccounts.link(
    COMPOSIO_ENTITY_ID,
    authConfigId,
    redirectUrl ? { callbackUrl: redirectUrl } : undefined,
  );

  if (!connectionRequest.redirectUrl) {
    throw new Error(
      `Composio did not return an OAuth URL for "${toolkit}". ` +
        `Make sure "${toolkit}" is a valid Composio app name.`,
    );
  }

  return {
    redirectUrl: connectionRequest.redirectUrl,
    connectedAccountId: connectionRequest.id ?? "",
  };
}

/**
 * List connected social accounts, optionally filtered by toolkit.
 */
export async function listConnectedAccounts(
  toolkit?: string,
): Promise<SocialAccount[]> {
  const client = getClient();
  const result = await client.connectedAccounts.list({
    userIds: [COMPOSIO_ENTITY_ID],
    ...(toolkit ? { toolkitSlugs: [toolkit] } : {}),
    statuses: ["ACTIVE"],
  });

  const items = result.items ?? [];
  return items.map((item) => ({
    id: item.id,
    platform: item.toolkit?.slug ?? "unknown",
    status: item.status?.toLowerCase() ?? "unknown",
    connectedAt: item.createdAt ?? "",
  }));
}

/**
 * Disconnect (delete) a connected account by ID.
 */
export async function disconnectAccount(accountId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error("Invalid account ID");
  }
  const client = getClient();
  await client.connectedAccounts.delete(accountId);
}
