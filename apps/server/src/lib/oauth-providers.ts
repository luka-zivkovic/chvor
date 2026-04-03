/**
 * Direct OAuth2 provider configurations for services where we handle
 * the OAuth flow locally (no Composio dependency).
 *
 * Users supply their own client ID/secret from the respective developer portals.
 */

import type { OAuthProviderConfig } from "./oauth-engine.ts";

export const DIRECT_OAUTH_PROVIDERS: OAuthProviderConfig[] = [
  {
    id: "google",
    name: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive.readonly",
      "openid",
      "email",
      "profile",
    ],
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
    },
    requiresSecret: true,
  },
  {
    id: "reddit",
    name: "Reddit",
    authUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    scopes: [
      "identity",
      "read",
      "submit",
      "privatemessages",
      "subscribe",
      "vote",
      "history",
    ],
    extraAuthParams: {
      duration: "permanent",
    },
    requiresSecret: false,
  },
];

export function getDirectOAuthProvider(id: string): OAuthProviderConfig | undefined {
  return DIRECT_OAUTH_PROVIDERS.find((p) => p.id === id);
}
