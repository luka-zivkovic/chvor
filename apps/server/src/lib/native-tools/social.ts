import { tool } from "ai";
import { z } from "zod";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Social Account Management (Composio)
// ---------------------------------------------------------------------------

const SOCIAL_CONNECT_NAME = "native__social_connect";
const socialConnectToolDef = tool({
  description:
    "[Social] Connect a social media account (Twitter/X, Reddit, LinkedIn, Instagram, etc.) via OAuth. " +
    "Returns a clickable authorization URL the user must visit to grant access. " +
    "Requires a Composio API key credential — if missing, guide the user to get one at https://app.composio.dev/settings",
  parameters: z.object({
    platform: z
      .string()
      .describe(
        "Platform to connect, e.g. 'twitter', 'reddit', 'linkedin', 'instagram', 'youtube', 'tiktok', 'facebook', 'bluesky', 'mastodon', 'pinterest', 'threads', 'discord', 'telegram'",
      ),
  }),
});

const handleSocialConnect: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  try {
    const { initiateConnection } = await import("../composio-client.ts");
    const platform = String(args.platform).toLowerCase().trim();

    const serverPort = process.env.PORT ?? "9147";
    const callbackUrl = `http://localhost:${serverPort}/api/social/callback`;

    const result = await initiateConnection(platform, callbackUrl);

    return {
      content: [
        {
          type: "text",
          text:
            `To connect your ${platform} account, open this link:\n\n` +
            `${result.redirectUrl}\n\n` +
            `After authorizing, you'll be redirected back and the connection will be active. ` +
            `Use native__social_list to verify the connection afterwards.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Social connect failed: ${msg}` }] };
  }
};

const SOCIAL_LIST_NAME = "native__social_list";
const socialListToolDef = tool({
  description:
    "[Social] List connected social media accounts across all providers (Composio OAuth and custom MCP integrations).",
  parameters: z.object({
    platform: z
      .string()
      .optional()
      .describe("Optional: filter by platform name (e.g. 'twitter')"),
  }),
});

const handleSocialList: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  try {
    const { listAllSocialConnections } = await import("../social-aggregator.ts");
    const platform = args.platform ? String(args.platform).toLowerCase().trim() : undefined;

    const connections = await listAllSocialConnections(platform);

    if (connections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: platform
              ? `No connected ${platform} accounts found. Use native__social_connect to connect one via Composio, or add a custom MCP tool.`
              : "No social accounts connected yet. Use native__social_connect to connect a platform via Composio, or add a custom MCP tool.",
          },
        ],
      };
    }

    const lines = connections.map((c, i) => {
      const parts = [`${i + 1}. **${c.platform}** — ${c.status} (via ${c.provider})`];
      if (c.connectedAt) parts[0] += `, connected ${c.connectedAt}`;
      if (c.id) parts.push(`   id: \`${c.id}\``);
      if (c.capabilities?.length) parts.push(`   capabilities: ${c.capabilities.join(", ")}`);
      return parts.join("\n");
    });

    return {
      content: [
        {
          type: "text",
          text: `Connected social accounts:\n\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Failed to list social accounts: ${msg}` }] };
  }
};

const SOCIAL_DISCONNECT_NAME = "native__social_disconnect";
const socialDisconnectToolDef = tool({
  description:
    "[Social] Disconnect a social media account. Use native__social_list first to get the account ID.",
  parameters: z.object({
    accountId: z.string().describe("The connected account ID to disconnect (from native__social_list)"),
  }),
});

const handleSocialDisconnect: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  try {
    const { disconnectAccount } = await import("../composio-client.ts");
    const accountId = String(args.accountId);

    await disconnectAccount(accountId);

    return {
      content: [
        {
          type: "text",
          text: `Account \`${accountId}\` has been disconnected successfully.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Failed to disconnect account: ${msg}` }] };
  }
};

export const socialModule: NativeToolModule = {
  defs: {
    [SOCIAL_CONNECT_NAME]: socialConnectToolDef,
    [SOCIAL_LIST_NAME]: socialListToolDef,
    [SOCIAL_DISCONNECT_NAME]: socialDisconnectToolDef,
  },
  handlers: {
    [SOCIAL_CONNECT_NAME]: handleSocialConnect,
    [SOCIAL_LIST_NAME]: handleSocialList,
    [SOCIAL_DISCONNECT_NAME]: handleSocialDisconnect,
  },
  mappings: {
    [SOCIAL_CONNECT_NAME]: { kind: "tool", id: "composio" },
    [SOCIAL_LIST_NAME]: { kind: "tool", id: "composio" },
    [SOCIAL_DISCONNECT_NAME]: { kind: "tool", id: "composio" },
  },
};
