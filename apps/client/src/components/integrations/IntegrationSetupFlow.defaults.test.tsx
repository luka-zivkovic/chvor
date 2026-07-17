import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IntegrationSetupFlowSnapshot, IntegrationSetupStartRequest } from "@chvor/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  submitCredentials: vi.fn(),
  acknowledgeInstruction: vi.fn(),
  confirm: vi.fn(),
  discovery: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: { integrationSetup: api } }));
vi.mock("@/components/credentials/OAuthConnectButton", () => ({
  OAuthConnectButton: () => <button type="button">Authorize</button>,
}));

import { IntegrationSetupFlow } from "./IntegrationSetupFlow";
import { manifest, snapshot, storageKey } from "./IntegrationSetupFlow.test-fixtures";

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("IntegrationSetupFlow manifest defaults", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  it("initializes required non-secret fields from manifest defaults", async () => {
    api.start.mockResolvedValue(snapshot());
    api.submitCredentials.mockResolvedValue(
      snapshot({ status: "completed", currentStepId: undefined, revision: 2 })
    );
    const defaultManifest = {
      ...manifest,
      credentials: [
        {
          ...manifest.credentials[0],
          fields: manifest.credentials[0].fields.map((field) =>
            field.id === "token"
              ? { ...field, required: false }
              : { ...field, required: true, default: "https://github.example" }
          ),
        },
      ],
    } as typeof manifest;

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={defaultManifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();

    const host = container.querySelector('[aria-label="Host"]') as HTMLInputElement;
    expect(host.value).toBe("https://github.example");
    const submit = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Save and continue")
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await flushEffects();

    expect(api.submitCredentials).toHaveBeenCalledWith(
      "flow-1",
      expect.objectContaining({ data: { host: "https://github.example" } })
    );
  });

  it("does not submit manifest defaults over stored values during reconfiguration", async () => {
    api.start.mockResolvedValue(
      snapshot({ mode: "reconfigure", targetCredentialId: "credential-existing" })
    );
    api.submitCredentials.mockResolvedValue(
      snapshot({ status: "completed", currentStepId: undefined, revision: 2 })
    );
    const defaultManifest = {
      ...manifest,
      credentials: [
        {
          ...manifest.credentials[0],
          fields: manifest.credentials[0].fields.map((field) =>
            field.id === "host" ? { ...field, default: "https://default.example" } : field
          ),
        },
      ],
    } as typeof manifest;

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={defaultManifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          mode="reconfigure"
          targetCredentialId="credential-existing"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();

    expect((container.querySelector('[aria-label="Host"]') as HTMLInputElement).value).toBe("");
    const submit = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Save and continue")
    ) as HTMLButtonElement;
    await act(async () => submit.click());
    await flushEffects();

    expect(api.submitCredentials).toHaveBeenCalledWith(
      "flow-1",
      expect.objectContaining({ data: {} })
    );
  });

  it("does not offer reuse when the server only allows replacing an OAuth account", async () => {
    api.start.mockResolvedValue(
      snapshot({
        status: "awaiting-confirmation",
        duplicateCandidates: [
          {
            id: "expired-account",
            name: "Expired account",
            type: "oauth-token-github",
            allowedDecisions: ["replace-existing"],
          },
        ],
      })
    );

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();

    expect(container.textContent).toContain("Replace existing — Expired account");
    expect(container.textContent).not.toContain("Reuse existing — Expired account");
  });

  it("reuses one durable start key across overlapping StrictMode effects", async () => {
    const startResolvers: Array<(flow: IntegrationSetupFlowSnapshot) => void> = [];
    api.start.mockImplementation(
      (_request: IntegrationSetupStartRequest) =>
        new Promise<IntegrationSetupFlowSnapshot>((resolve) => startResolvers.push(resolve))
    );

    await act(async () =>
      root.render(
        <StrictMode>
          <IntegrationSetupFlow
            manifest={manifest}
            credentialType="github"
            manifestCredentialId="credential.github"
            onClose={() => {}}
          />
        </StrictMode>
      )
    );

    expect(api.start).toHaveBeenCalledTimes(2);
    const startRequests = api.start.mock.calls.map(
      ([request]) => request as IntegrationSetupStartRequest
    );
    const idempotencyKey = startRequests[0].idempotencyKey;
    expect(idempotencyKey).toMatch(/^setup-start:/);
    expect(startRequests.map((request) => request.idempotencyKey)).toEqual([
      idempotencyKey,
      idempotencyKey,
    ]);
    expect(window.localStorage.getItem(`${storageKey}:start`)).toBe(idempotencyKey);

    await act(async () => {
      startResolvers.forEach((resolve) => resolve(snapshot({ id: idempotencyKey as string })));
      await Promise.resolve();
    });
    await flushEffects();

    expect(window.localStorage.getItem(storageKey)).toBe(idempotencyKey);
    expect(window.localStorage.getItem(`${storageKey}:start`)).toBeNull();
    expect(window.localStorage).toHaveLength(1);
  });
});
