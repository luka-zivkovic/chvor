import type { IntegrationAuthStatus, OAuthConnection, OAuthProviderDef } from "@chvor/shared";

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type OAuthConnectionView = OAuthConnection & {
  authStatus?: IntegrationAuthStatus;
  needsReauthentication?: boolean;
  failureCode?: string;
  oauthKind?: "direct" | "synthesized";
};

export interface OAuthFlowReference {
  flowId?: string;
  integrationId?: string;
  manifestVersion?: string;
  manifestCredentialId?: string;
  /** Exact OAuth account target; intentionally separate from setup/app credentials. */
  oauthCredentialId?: string;
  /** Exact provider app/client credential when more than one is configured. */
  appCredentialId?: string;
}

export interface SynthesizedOAuthInitiate extends OAuthFlowReference {
  credentialType: string;
  providerName: string;
  clientId: string;
  clientSecret?: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export function createOAuthApi(request: JsonRequest) {
  return {
    providers: () =>
      request<{
        providers: (OAuthProviderDef & {
          connected: boolean;
          hasSetupCredentials: boolean;
          needsReauthentication?: boolean;
        })[];
        connections: OAuthConnectionView[];
        hasComposioKey: boolean;
      }>("/oauth/providers"),
    initiate: (provider: string, options: OAuthFlowReference = {}) =>
      request<{
        redirectUrl: string;
        connectionId: string;
        flowId?: string;
        oauthCredentialId?: string;
        callbackOrigin: string;
        expiresAt?: string;
        method: string;
      }>("/oauth/initiate", {
        method: "POST",
        body: JSON.stringify({ provider, ...options }),
      }),
    connections: () => request<OAuthConnectionView[]>("/oauth/connections"),
    disconnect: (id: string) =>
      request<{ disconnected: boolean; method: string }>(`/oauth/connections/${id}`, {
        method: "DELETE",
      }),
    refresh: (credentialId: string) =>
      request<{
        refreshed: boolean;
        expiresAt?: string | null;
        authStatus?: IntegrationAuthStatus;
      }>(`/oauth/refresh/${credentialId}`, { method: "POST" }),
    synthesizedRedirectUrl: () =>
      request<{ redirectUrl: string }>("/oauth/synthesized/redirect-url"),
    synthesizedInitiate: (body: SynthesizedOAuthInitiate) =>
      request<{
        redirectUrl: string;
        connectionId: string;
        flowId?: string;
        flowRevision?: number;
        oauthCredentialId?: string;
        callbackOrigin: string;
        expiresAt?: string;
        method: string;
        redirectUriUsed: string;
      }>("/oauth/synthesized/initiate", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  };
}
