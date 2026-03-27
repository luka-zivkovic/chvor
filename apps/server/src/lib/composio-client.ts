/**
 * Composio REST API client — thin wrapper for social account management.
 * Composio handles OAuth token storage & refresh for 500+ apps.
 */

import { listCredentials, getCredentialData } from "../db/credential-store.ts";

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";
const COMPOSIO_ENTITY_ID = "default"; // Chvor is single-user

interface ComposioConnectedAccount {
  id: string;
  status: "INITIATED" | "ACTIVE" | "FAILED" | "INACTIVE";
  appName: string;
  createdAt: string;
  updatedAt: string;
}

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

  // Return first value (apiKey)
  return Object.values(full.data)[0] ?? null;
}

async function composioFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    throw new Error(
      "No Composio API key found. Please add your Composio API key first.\n" +
        "You can get a free key at https://app.composio.dev/settings",
    );
  }

  const url = `${COMPOSIO_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Composio API error (${res.status}): ${body}`);
  }

  return res;
}

/**
 * Initiate an OAuth connection for a given toolkit (e.g. "twitter", "reddit").
 * Returns a URL the user must visit to authorize.
 */
export async function initiateConnection(
  toolkit: string,
  redirectUrl?: string,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const res = await composioFetch("/connected_accounts", {
    method: "POST",
    body: JSON.stringify({
      integration_id: toolkit,
      user_id: COMPOSIO_ENTITY_ID,
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    }),
  });

  const data = (await res.json()) as {
    redirectUrl?: string;
    connectionStatus?: string;
    connectedAccountId?: string;
  };

  if (!data.redirectUrl) {
    throw new Error(
      `Composio did not return an OAuth URL for "${toolkit}". ` +
        `Make sure "${toolkit}" is a valid Composio app name.`,
    );
  }

  return {
    redirectUrl: data.redirectUrl,
    connectedAccountId: data.connectedAccountId ?? "",
  };
}

/**
 * List connected social accounts, optionally filtered by toolkit.
 */
export async function listConnectedAccounts(
  toolkit?: string,
): Promise<SocialAccount[]> {
  const params = new URLSearchParams();
  params.set("user_ids", COMPOSIO_ENTITY_ID);
  if (toolkit) params.set("toolkit_slugs", toolkit);
  params.set("statuses", "ACTIVE");

  const res = await composioFetch(`/connected_accounts?${params.toString()}`);
  const data = (await res.json()) as {
    items?: ComposioConnectedAccount[];
  };

  return (data.items ?? []).map((item) => ({
    id: item.id,
    platform: item.appName,
    status: item.status.toLowerCase(),
    connectedAt: item.createdAt,
  }));
}

/**
 * Disconnect (delete) a connected account by ID.
 */
export async function disconnectAccount(accountId: string): Promise<void> {
  await composioFetch(`/connected_accounts/${accountId}`, {
    method: "DELETE",
  });
}
