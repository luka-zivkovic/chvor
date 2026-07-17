import type { IntegrationManifestV2, IntegrationSetupFlowSnapshot } from "@chvor/shared";

import { integrationSetupResumeKey } from "./integration-setup-resume";

export const now = "2026-07-13T10:00:00.000Z";
const later = "2026-07-13T11:00:00.000Z";

export const manifest: IntegrationManifestV2 = {
  schemaVersion: 2,
  id: "provider.integration.github",
  version: "1.2.3",
  name: "GitHub",
  description: "Connect GitHub tools.",
  ownership: { kind: "first-party", name: "Chvor" },
  source: { kind: "built-in", package: "@chvor/github" },
  mcpServers: [],
  tools: [],
  credentials: [
    {
      id: "credential.github",
      name: "GitHub credentials",
      description: "A GitHub access token.",
      fields: [
        {
          id: "token",
          label: "Access token",
          description: "A token with repository access.",
          sensitivity: "secret",
          required: true,
        },
        {
          id: "host",
          label: "Host",
          description: "Optional enterprise host.",
          sensitivity: "url",
          required: false,
        },
      ],
    },
  ],
  oauth: [
    {
      id: "oauth.direct",
      mode: "direct",
      provider: "github",
      authorizationUrl: "https://github.example/authorize",
      tokenUrl: "https://github.example/token",
      scopes: ["repo"],
      clientId: { credentialId: "credential.github", fieldId: "token" },
    },
  ],
  capabilities: [],
  requestedAccess: { network: [], filesystem: [], process: [], environment: [] },
  setup: [
    {
      id: "setup.credential.github",
      kind: "credential",
      title: "Configure GitHub",
      credentialId: "credential.github",
    },
    {
      id: "setup.check.github.token",
      kind: "diagnostic",
      title: "Validate GitHub token",
      checkId: "check.github.token",
    },
    {
      id: "setup.oauth.github",
      kind: "oauth",
      title: "Authorize GitHub",
      oauthId: "oauth.direct",
    },
  ],
  diagnostics: [
    {
      id: "check.github.token",
      kind: "credential",
      name: "Check GitHub token",
      description: "Confirm GitHub token metadata is available.",
      credentialField: { credentialId: "credential.github", fieldId: "token" },
    },
  ],
  quality: { tier: "experimental", evidence: [] },
};

export const storageKey = integrationSetupResumeKey({
  manifestId: manifest.id,
  manifestVersion: manifest.version,
  manifestCredentialId: "credential.github",
  credentialType: "github",
  mode: "setup",
});

export function snapshot(
  overrides: Partial<IntegrationSetupFlowSnapshot> = {}
): IntegrationSetupFlowSnapshot {
  return {
    schemaVersion: 1,
    id: "flow-1",
    integrationId: manifest.id,
    manifestVersion: manifest.version,
    manifestCredentialId: "credential.github",
    currentStepId: "setup.credential.github",
    credentialType: "github",
    mode: "setup",
    status: "awaiting-input",
    authStatus: "unknown",
    oauthCreateAdditional: false,
    steps: [
      {
        id: "setup.credential.github",
        kind: "credential",
        status: "active",
        attempts: 1,
        startedAt: now,
      },
    ],
    duplicateCandidates: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: later,
    ...overrides,
  };
}

export function oauthSnapshot(
  overrides: Partial<IntegrationSetupFlowSnapshot> = {}
): IntegrationSetupFlowSnapshot {
  return snapshot({
    status: "awaiting-oauth",
    currentStepId: "setup.oauth.github",
    steps: [
      {
        id: "setup.oauth.github",
        kind: "oauth",
        status: "active",
        attempts: 1,
        startedAt: now,
      },
    ],
    ...overrides,
  });
}
