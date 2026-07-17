import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationManifestV2, OAuthConnection, OAuthProviderDef } from "@chvor/shared";

const {
  manifests,
  fetchCredentials,
  fetchOAuthState,
  openPanel,
  featureState,
  setupFlowProps,
  legacyOAuthProps,
} = vi.hoisted(() => ({
  manifests: vi.fn(),
  fetchCredentials: vi.fn(),
  fetchOAuthState: vi.fn(),
  openPanel: vi.fn(),
  featureState: {
    credentials: [] as Array<{ id: string; name: string; type: string }>,
    integrationProviders: [],
    oauthProviders: [] as OAuthProviderDef[],
    oauthConnections: [] as OAuthConnection[],
    hasComposioKey: false,
    credentialsLoading: false,
    credentialsError: null as string | null,
  },
  setupFlowProps: vi.fn(),
  legacyOAuthProps: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: { integrations: { manifests } } }));
vi.mock("../../stores/feature-store", () => ({
  useFeatureStore: () => ({
    ...featureState,
    fetchCredentials,
    fetchOAuthState,
  }),
}));
vi.mock("../../stores/ui-store", () => ({
  useUIStore: (selector: (state: { openPanel: typeof openPanel }) => unknown) =>
    selector({ openPanel }),
}));
vi.mock("../integrations/IntegrationSetupFlow", () => ({
  IntegrationSetupFlow: (props: unknown) => {
    setupFlowProps(props);
    return <div>Manifest reauthentication open</div>;
  },
}));
vi.mock("../credentials/OAuthConnectButton", () => ({
  OAuthConnectButton: (props: unknown) => {
    legacyOAuthProps(props);
    return <button type="button">Legacy OAuth connect</button>;
  },
}));
vi.mock("../credentials/AddCredentialDialog", () => ({
  AddCredentialDialog: () => <div>Credential dialog</div>,
}));
vi.mock("@/components/ui/ProviderIcon", () => ({
  ProviderIcon: () => <span aria-hidden="true" />,
}));

import { IntegrationsPanel } from "./IntegrationsPanel";

const provider: OAuthProviderDef = {
  id: "google",
  name: "Google",
  icon: "google",
  method: "direct",
  category: "productivity",
  description: "Google account",
  setupCredentialType: "google-oauth",
};

const manifest: IntegrationManifestV2 = {
  schemaVersion: 2,
  id: "oauth.google",
  version: "1.2.3",
  name: "Google",
  description: "Google account",
  ownership: { kind: "first-party", name: "Chvor" },
  source: { kind: "built-in", package: "@chvor/google" },
  mcpServers: [],
  tools: [],
  credentials: [
    {
      id: "credential.google-oauth",
      name: "Google OAuth app",
      description: "Google OAuth app credentials",
      fields: [
        {
          id: "client-id",
          label: "Client ID",
          description: "OAuth client ID",
          sensitivity: "text",
          required: true,
        },
        {
          id: "client-secret",
          label: "Client secret",
          description: "OAuth client secret",
          sensitivity: "secret",
          required: true,
        },
      ],
    },
  ],
  oauth: [
    {
      id: "oauth.direct",
      mode: "direct",
      provider: "google",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["openid"],
      clientId: { credentialId: "credential.google-oauth", fieldId: "client-id" },
      clientSecret: {
        credentialId: "credential.google-oauth",
        fieldId: "client-secret",
      },
    },
  ],
  capabilities: [],
  requestedAccess: { network: [], filesystem: [], process: [], environment: [] },
  setup: [
    {
      id: "setup.oauth.direct",
      title: "Authorize Google",
      kind: "oauth",
      oauthId: "oauth.direct",
    },
  ],
  diagnostics: [],
  quality: { tier: "experimental", evidence: [] },
};

function reauthenticationConnection(id = "oauth-account"): OAuthConnection {
  return {
    id,
    platform: "google",
    method: "direct",
    status: "expired",
    connectedAt: "2026-07-13T10:00:00.000Z",
    credentialId: id,
    authStatus: "expired",
    needsReauthentication: true,
    oauthKind: "direct",
    reauthenticationTarget: {
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: "credential.google-oauth",
      oauthManifestCredentialId: "oauth.direct",
      credentialType: "google-oauth",
      targetCredentialId: "google-app-credential",
      oauthCredentialId: id,
    },
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const candidate = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label
  );
  if (!candidate) throw new Error(`Missing ${label} button`);
  return candidate;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("IntegrationsPanel direct OAuth reauthentication", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    featureState.oauthProviders = [provider];
    featureState.oauthConnections = [reauthenticationConnection()];
    manifests.mockResolvedValue({ manifests: [manifest], diagnostics: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens exact manifest-bound reauthentication instead of standalone OAuth", async () => {
    await act(async () => root.render(<IntegrationsPanel />));
    await act(async () => button(container, "Reconnect").click());
    await flushEffects();

    expect(manifests).toHaveBeenCalledOnce();
    expect(setupFlowProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        manifest,
        credentialType: "google-oauth",
        manifestCredentialId: "credential.google-oauth",
        mode: "reauthenticate",
        targetCredentialId: "google-app-credential",
        oauthCredentialId: "oauth-account",
      })
    );
    expect(legacyOAuthProps).not.toHaveBeenCalled();
  });

  it("routes legacy reauthentication metadata to the catalog without OAuth initiation", async () => {
    const legacy = reauthenticationConnection();
    delete legacy.reauthenticationTarget;
    featureState.oauthConnections = [legacy];

    await act(async () => root.render(<IntegrationsPanel />));
    await act(async () => button(container, "Review in catalog").click());

    expect(openPanel).toHaveBeenCalledWith("integration-catalog");
    expect(manifests).not.toHaveBeenCalled();
    expect(legacyOAuthProps).not.toHaveBeenCalled();
  });

  it("routes multiple accounts to explicit review instead of choosing one", async () => {
    featureState.oauthConnections = [
      reauthenticationConnection("oauth-account-one"),
      reauthenticationConnection("oauth-account-two"),
    ];

    await act(async () => root.render(<IntegrationsPanel />));
    await act(async () => button(container, "Review accounts").click());

    expect(openPanel).toHaveBeenCalledWith("integration-catalog");
    expect(manifests).not.toHaveBeenCalled();
    expect(legacyOAuthProps).not.toHaveBeenCalled();
  });
});
