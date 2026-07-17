import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IntegrationCatalogEntry,
  IntegrationManifestV1,
  IntegrationSetupFlowSnapshot,
} from "@chvor/shared";

const {
  catalog,
  manifests,
  listSetupFlows,
  research,
  fetchCredentials,
  credentialState,
  setupFlowProps,
  legacyDialogProps,
} = vi.hoisted(() => ({
  catalog: vi.fn(),
  manifests: vi.fn(),
  listSetupFlows: vi.fn(),
  research: vi.fn(),
  fetchCredentials: vi.fn(),
  credentialState: {
    credentials: [] as Array<{ id: string; type: string; name: string }>,
  },
  setupFlowProps: vi.fn(),
  legacyDialogProps: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    integrations: { catalog, manifests, research },
    integrationSetup: { list: listSetupFlows },
  },
}));

vi.mock("../../stores/feature-store", () => ({
  useFeatureStore: () => ({
    credentials: credentialState.credentials,
    fetchCredentials,
  }),
}));

vi.mock("../integrations/IntegrationSetupFlow", () => ({
  IntegrationSetupFlow: (props: unknown) => {
    setupFlowProps(props);
    return <div>Manifest setup open</div>;
  },
}));

vi.mock("../credentials/AddCredentialDialog", () => ({
  AddCredentialDialog: (props: unknown) => {
    legacyDialogProps(props);
    return <div>Legacy credential dialog open</div>;
  },
}));

vi.mock("@/components/ui/ProviderIcon", () => ({
  ProviderIcon: () => <span aria-hidden="true" />,
}));

import { IntegrationCatalogPanel } from "./IntegrationCatalogPanel";

const githubEntry: IntegrationCatalogEntry = {
  id: "integration:github",
  source: "provider-registry",
  name: "GitHub",
  description: "GitHub tools",
  category: "integration",
  credentialType: "github",
  manifestId: "provider.integration.github",
  manifestVersion: "2.0.0",
  manifestCredentialId: "credential.github",
  installed: false,
};

const githubManifest: IntegrationManifestV1 = {
  schemaVersion: 1,
  id: "provider.integration.github",
  version: "2.0.0",
  name: "GitHub",
  description: "GitHub tools",
  ownership: { kind: "first-party", name: "Chvor" },
  source: { kind: "built-in", package: "@chvor/github" },
  mcpServers: [],
  tools: [],
  credentials: [
    {
      id: "credential.github",
      name: "GitHub credentials",
      description: "GitHub token",
      fields: [
        {
          id: "token",
          label: "Token",
          description: "GitHub token",
          sensitivity: "secret",
          required: true,
        },
      ],
    },
  ],
  oauth: [],
  capabilities: [],
  requestedAccess: { network: [], filesystem: [], process: [], environment: [] },
  setup: [
    {
      id: "setup.credential.github",
      title: "Configure GitHub",
      kind: "credential",
      credentialId: "credential.github",
    },
  ],
  diagnostics: [],
  quality: { tier: "experimental", evidence: [] },
};

function activeSetupFlow(
  overrides: Partial<IntegrationSetupFlowSnapshot> = {}
): IntegrationSetupFlowSnapshot {
  return {
    schemaVersion: 1,
    id: "flow-partial-setup",
    integrationId: githubManifest.id,
    manifestVersion: githubManifest.version,
    manifestCredentialId: "credential.github",
    credentialType: "github",
    mode: "setup",
    status: "awaiting-oauth",
    authStatus: "unknown",
    currentStepId: "setup.oauth.github",
    steps: [
      {
        id: "setup.credential.github",
        kind: "credential",
        status: "completed",
        attempts: 1,
        startedAt: "2026-07-13T10:00:00.000Z",
        completedAt: "2026-07-13T10:01:00.000Z",
      },
      {
        id: "setup.oauth.github",
        kind: "oauth",
        status: "active",
        attempts: 1,
        startedAt: "2026-07-13T10:01:00.000Z",
      },
    ],
    duplicateCandidates: [],
    revision: 3,
    oauthCreateAdditional: false,
    targetCredentialId: "credential-created-during-setup",
    oauthCredentialId: "oauth-account-selected-during-setup",
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:01:00.000Z",
    expiresAt: "2026-07-13T11:00:00.000Z",
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function actionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label
  );
  if (!result) throw new Error(`Missing ${label} button`);
  return result;
}

describe("IntegrationCatalogPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    credentialState.credentials = [
      { id: "credential-existing", type: "github", name: "Existing GitHub" },
    ];
    catalog.mockResolvedValue({ entries: [githubEntry], total: 1 });
    manifests.mockResolvedValue({ manifests: [githubManifest], diagnostics: [] });
    listSetupFlows.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens manifest setup with the exact manifest version and credential declaration", async () => {
    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();
    await act(async () => actionButton(container, "Connect").click());

    expect(container.textContent).toContain("Manifest setup open");
    expect(setupFlowProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        manifest: githubManifest,
        credentialType: "github",
        manifestCredentialId: "credential.github",
        mode: "setup",
      })
    );
    expect(legacyDialogProps).not.toHaveBeenCalled();
  });

  it("starts an installed manifest entry in reconfigure mode", async () => {
    catalog.mockResolvedValue({ entries: [{ ...githubEntry, installed: true }], total: 1 });
    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();
    await act(async () => actionButton(container, "Manage").click());

    expect(setupFlowProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "reconfigure",
        manifest: githubManifest,
        targetCredentialId: "credential-existing",
      })
    );
  });

  it("resumes a partial setup after its first credential marks the entry installed", async () => {
    catalog.mockResolvedValue({ entries: [{ ...githubEntry, installed: true }], total: 1 });
    listSetupFlows.mockResolvedValue([activeSetupFlow()]);

    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();
    await act(async () => actionButton(container, "Manage").click());

    expect(setupFlowProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialFlowId: "flow-partial-setup",
        mode: "setup",
        targetCredentialId: "credential-created-during-setup",
        oauthCredentialId: "oauth-account-selected-during-setup",
        manifest: githubManifest,
      })
    );
  });

  it("uses setup mode for ambiguous installed credentials so confirmation can choose", async () => {
    credentialState.credentials = [
      { id: "credential-first", type: "github", name: "First GitHub" },
      { id: "credential-second", type: "github", name: "Second GitHub" },
    ];
    catalog.mockResolvedValue({ entries: [{ ...githubEntry, installed: true }], total: 1 });
    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();
    await act(async () => actionButton(container, "Manage").click());

    const props = setupFlowProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props).toEqual(expect.objectContaining({ mode: "setup", manifest: githubManifest }));
    expect(props).not.toHaveProperty("targetCredentialId");
  });

  it("retains the legacy credential dialog when no active manifest maps safely", async () => {
    catalog.mockResolvedValue({
      entries: [
        {
          ...githubEntry,
          manifestId: undefined,
          manifestVersion: undefined,
          manifestCredentialId: undefined,
        },
      ],
      total: 1,
    });
    manifests.mockResolvedValue({ manifests: [], diagnostics: [] });
    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();
    await act(async () => actionButton(container, "Connect").click());

    expect(container.textContent).toContain("Legacy credential dialog open");
    expect(legacyDialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialCredType: "github" })
    );
    expect(setupFlowProps).not.toHaveBeenCalled();
  });

  it("fails closed instead of fuzzily matching a stale catalog manifest reference", async () => {
    catalog.mockResolvedValue({
      entries: [{ ...githubEntry, manifestVersion: "1.9.9" }],
      total: 1,
    });
    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();
    await act(async () => actionButton(container, "Connect").click());

    expect(container.textContent).toContain("no longer matches its active setup manifest");
    expect(legacyDialogProps).not.toHaveBeenCalled();
    expect(setupFlowProps).not.toHaveBeenCalled();
  });

  it("does not silently bypass manifest setup when the manifest API fails", async () => {
    manifests.mockRejectedValue(new Error("Manifest service unavailable"));
    await act(async () => root.render(<IntegrationCatalogPanel />));
    await flushEffects();

    const connect = actionButton(container, "Connect");
    expect(connect.disabled).toBe(true);
    expect(container.textContent).toContain("Manifest-driven setup is unavailable");
    expect(container.textContent).toContain("Manifest service unavailable");
    expect(setupFlowProps).not.toHaveBeenCalled();
    expect(legacyDialogProps).not.toHaveBeenCalled();
  });
});
