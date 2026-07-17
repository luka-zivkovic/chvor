import type {
  IntegrationAuthStatus,
  OAuthConnection,
  OAuthReauthenticationTarget,
} from "@chvor/shared";

export type OAuthCredentialData = Record<string, string>;

export type OAuthConnectionWithAuth = OAuthConnection & {
  authStatus?: IntegrationAuthStatus;
  needsReauthentication?: boolean;
  failureCode?: string;
  oauthKind?: "direct" | "synthesized";
  reauthenticationTarget?: OAuthReauthenticationTarget;
};

export interface OAuthFlowReference {
  flowId?: string;
  targetCredentialId?: string;
  oauthCredentialId?: string;
  integrationId?: string;
  manifestVersion?: string;
  manifestCredentialId?: string;
  appCredentialId?: string;
}

export interface DirectOAuthInitiate extends OAuthFlowReference {
  provider: string;
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
