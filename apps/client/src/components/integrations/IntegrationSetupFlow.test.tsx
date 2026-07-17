import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationManifestV2, IntegrationSetupFlowSnapshot } from "@chvor/shared";

const {
  start,
  get,
  submitCredentials,
  acknowledgeInstruction,
  confirm,
  discovery,
  cancel,
  oauthButtonProps,
} = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  submitCredentials: vi.fn(),
  acknowledgeInstruction: vi.fn(),
  confirm: vi.fn(),
  discovery: vi.fn(),
  cancel: vi.fn(),
  oauthButtonProps: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    integrationSetup: {
      start,
      get,
      submitCredentials,
      acknowledgeInstruction,
      confirm,
      discovery,
      cancel,
    },
  },
}));

vi.mock("@/components/credentials/OAuthConnectButton", () => ({
  OAuthConnectButton: (props: unknown) => {
    oauthButtonProps(props);
    return <button type="button">Authorize</button>;
  },
}));

import { IntegrationSetupFlow } from "./IntegrationSetupFlow";
import {
  manifest,
  now,
  oauthSnapshot,
  snapshot,
  storageKey,
} from "./IntegrationSetupFlow.test-fixtures";
import { integrationSetupResumeKey } from "./integration-setup-resume";

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushAnimationFrame() {
  await act(
    async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

describe("IntegrationSetupFlow", () => {
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

  it("resumes after remount while persisting only the safe flow id", async () => {
    window.localStorage.setItem(storageKey, "flow-1");
    get.mockResolvedValue(snapshot());

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

    const secret = container.querySelector('[aria-label="Access token"]') as HTMLInputElement;
    await act(async () => setInputValue(secret, "never-store-this-secret"));
    expect(window.localStorage.getItem(storageKey)).toBe("flow-1");
    expect(JSON.stringify(window.localStorage)).not.toContain("never-store-this-secret");

    await act(async () => root.unmount());
    root = createRoot(container);
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

    expect(get).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect((container.querySelector('[aria-label="Access token"]') as HTMLInputElement).value).toBe(
      ""
    );
    expect(storageKey).toContain("provider.integration.github");
    expect(storageKey).toContain("1.2.3");
    expect(storageKey).toContain("credential.github");
    expect(storageKey).toContain(":github:setup:");
  });
  it("replaces an expired storage-derived flow instead of retrying it forever", async () => {
    window.localStorage.setItem(storageKey, "flow-expired");
    get.mockRejectedValue(
      Object.assign(new Error("Integration setup flow expired"), {
        status: 400,
        code: "integration_setup_flow_expired",
      })
    );
    start.mockResolvedValue(snapshot({ id: "flow-replacement" }));
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
    expect(get).toHaveBeenCalledWith("flow-expired");
    expect(start).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(storageKey)).toBe("flow-replacement");
  });
  it("accepts an explicitly requested replacement flow even at a lower revision", async () => {
    start.mockResolvedValue(snapshot({ revision: 7 }));
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
    get.mockResolvedValue(snapshot({ id: "flow-2", revision: 1 }));
    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          initialFlowId="flow-2"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();
    expect(get).toHaveBeenCalledWith("flow-2");
    expect(window.localStorage.getItem(storageKey)).toBe("flow-2");
  });
  it("keeps close actions disabled until a newly created flow can be resumed", async () => {
    let resolveStart!: (flow: IntegrationSetupFlowSnapshot) => void;
    start.mockReturnValue(
      new Promise<IntegrationSetupFlowSnapshot>((resolve) => {
        resolveStart = resolve;
      })
    );
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={onClose}
        />
      )
    );
    const close = container.querySelector('[aria-label="Close setup"]') as HTMLButtonElement;
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(close.disabled).toBe(true);
    expect(button(container, "Close and resume later").disabled).toBe(true);
    await flushAnimationFrame();
    expect(document.activeElement).toBe(dialog);
    await act(async () => close.click());
    await act(async () => (container.firstElementChild as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => resolveStart(snapshot({ id: "flow-created" })));
    await flushEffects();
    await flushAnimationFrame();
    expect(window.localStorage.getItem(storageKey)).toBe("flow-created");
    expect(close.disabled).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Access token"]'));
  });
  it("discards a stored snapshot whose manifest identity does not match", async () => {
    window.localStorage.setItem(storageKey, "flow-wrong-version");
    get.mockResolvedValue(snapshot({ manifestVersion: "9.9.9" }));
    start.mockResolvedValue(snapshot({ id: "flow-correct" }));

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

    expect(get).toHaveBeenCalledWith("flow-wrong-version");
    expect(start).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(storageKey)).toBe("flow-correct");
  });
  it("discards a resumed flow whose setup or OAuth target identity does not match", async () => {
    const targetKey = integrationSetupResumeKey({
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      manifestCredentialId: "credential.github",
      credentialType: "github",
      mode: "reauthenticate",
      setupTargetCredentialId: "setup-target",
      oauthCredentialId: "oauth-target",
    });
    window.localStorage.setItem(targetKey, "flow-wrong-targets");
    get.mockResolvedValue(
      snapshot({
        id: "flow-wrong-targets",
        mode: "reauthenticate",
        targetCredentialId: "other-setup-target",
        oauthCredentialId: "other-oauth-target",
      })
    );
    start.mockResolvedValue(
      snapshot({
        id: "flow-correct-targets",
        mode: "reauthenticate",
        targetCredentialId: "setup-target",
        oauthCredentialId: "oauth-target",
      })
    );

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          mode="reauthenticate"
          targetCredentialId="setup-target"
          oauthCredentialId="oauth-target"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();

    expect(start).toHaveBeenCalledTimes(1);
    expect(targetKey).toContain("setup-target:oauth-target");
    expect(window.localStorage.getItem(targetKey)).toBe("flow-correct-targets");
  });
  it("keeps a resumable id on transient reload failure instead of duplicating the flow", async () => {
    window.localStorage.setItem(storageKey, "flow-1");
    get.mockRejectedValue(Object.assign(new Error("Temporarily unavailable"), { status: 503 }));

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

    expect(start).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(storageKey)).toBe("flow-1");
    expect(container.textContent).toContain("Temporarily unavailable");
    await act(async () => button(container, "Retry").click());
    await flushEffects();
    expect(get).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ["Reuse existing", "reuse-existing", "credential-existing"],
    ["Replace existing", "replace-existing", "credential-existing"],
    ["Create a separate", "create-additional", undefined],
  ] as const)("submits the explicit %s duplicate choice", async (label, decision, credentialId) => {
    start.mockResolvedValue(
      snapshot({
        status: "awaiting-confirmation",
        duplicateCandidates: [
          {
            id: "credential-existing",
            name: "Existing GitHub",
            type: "github",
            accountLabel: "octocat@example.com",
            allowedDecisions: ["reuse-existing", "replace-existing"],
          },
        ],
      })
    );
    confirm.mockResolvedValue(snapshot({ status: "completed", currentStepId: undefined }));

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

    const option = Array.from(container.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes(label)
    );
    await act(async () => (option?.querySelector("input") as HTMLInputElement).click());
    await act(async () => button(container, "Confirm choice").click());
    await flushEffects();

    expect(confirm).toHaveBeenCalledWith("flow-1", {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 1,
      decision,
      ...(credentialId ? { credentialId } : {}),
    });
  });
  it("accepts same-revision candidate repairs and clears a now-invalid choice", async () => {
    const candidate: IntegrationSetupFlowSnapshot["duplicateCandidates"][number] = {
      id: "credential-existing",
      name: "Existing GitHub",
      type: "github",
      allowedDecisions: ["reuse-existing", "replace-existing"],
    };
    start.mockResolvedValue(
      snapshot({ status: "awaiting-confirmation", duplicateCandidates: [candidate] })
    );
    confirm.mockResolvedValue(
      snapshot({
        status: "awaiting-confirmation",
        duplicateCandidates: [{ ...candidate, allowedDecisions: ["replace-existing"] }],
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
    const reuse = container.querySelector(
      'input[value="reuse-existing:credential-existing"]'
    ) as HTMLInputElement;
    await act(async () => reuse.click());
    await act(async () => button(container, "Confirm choice").click());
    await flushEffects();

    expect(container.querySelector('input[value="reuse-existing:credential-existing"]')).toBeNull();
    expect(
      container.querySelector('input[value="replace-existing:credential-existing"]')
    ).not.toBeNull();
    expect(button(container, "Confirm choice").disabled).toBe(true);
  });
  it("refetches the flow and preserves no submitted secret after a revision conflict", async () => {
    start.mockResolvedValue(snapshot());
    submitCredentials.mockRejectedValue(
      Object.assign(new Error("Revision conflict"), {
        status: 409,
        expectedRevision: 1,
        actualRevision: 2,
      })
    );
    get.mockResolvedValue(
      snapshot({
        status: "discovering",
        revision: 2,
        currentStepId: undefined,
        steps: [
          {
            id: "setup.credential.github",
            kind: "credential",
            status: "completed",
            attempts: 1,
            startedAt: now,
            completedAt: now,
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
    await act(async () =>
      setInputValue(
        container.querySelector('[aria-label="Access token"]') as HTMLInputElement,
        "temporary-secret"
      )
    );
    await act(async () => button(container, "Save and continue").click());
    await flushEffects();

    expect(get).toHaveBeenCalledWith("flow-1");
    expect(container.textContent).toContain("Latest progress loaded");
    expect(container.textContent).toContain("Discovering available capabilities");
    expect(JSON.stringify(window.localStorage)).not.toContain("temporary-secret");
    expect(discovery).not.toHaveBeenCalled();
  });

  it.each(["reconfigure", "reauthenticate"] as const)(
    "allows blank required fields during %s so stored values are preserved",
    async (mode) => {
      start.mockResolvedValue(snapshot({ mode, targetCredentialId: "credential-existing" }));
      submitCredentials.mockResolvedValue(
        snapshot({
          mode,
          targetCredentialId: "credential-existing",
          status: "completed",
          currentStepId: undefined,
          revision: 2,
        })
      );

      await act(async () =>
        root.render(
          <IntegrationSetupFlow
            manifest={manifest}
            credentialType="github"
            manifestCredentialId="credential.github"
            mode={mode}
            targetCredentialId="credential-existing"
            onClose={() => {}}
          />
        )
      );
      await flushEffects();

      const submit = button(
        container,
        mode === "reauthenticate" ? "Save and reauthenticate" : "Save and continue"
      );
      expect(submit.disabled).toBe(false);
      expect(container.textContent).toContain("keep their existing values");
      await act(async () => submit.click());
      await flushEffects();

      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ mode, targetCredentialId: "credential-existing" })
      );
      expect(submitCredentials).toHaveBeenCalledWith(
        "flow-1",
        expect.objectContaining({ data: {} })
      );
    }
  );
  it("requests strict server-derived diagnostics and retries transient failures", async () => {
    const onCompleted = vi.fn();
    vi.useFakeTimers();
    start.mockResolvedValue(snapshot());
    submitCredentials.mockResolvedValue(
      snapshot({
        status: "discovering",
        authStatus: "active",
        targetCredentialId: "credential-created",
        currentStepId: "setup.check.github.token",
        revision: 2,
        steps: [
          {
            id: "setup.credential.github",
            kind: "credential",
            status: "completed",
            attempts: 1,
            startedAt: now,
            completedAt: now,
          },
          {
            id: "setup.check.github.token",
            kind: "diagnostic",
            status: "active",
            attempts: 1,
            startedAt: now,
          },
        ],
      })
    );
    discovery.mockRejectedValueOnce(new Error("Transient discovery failure")).mockResolvedValue(
      snapshot({
        status: "completed",
        authStatus: "active",
        targetCredentialId: "credential-created",
        currentStepId: undefined,
        revision: 3,
        steps: [
          {
            id: "setup.credential.github",
            kind: "credential",
            status: "completed",
            attempts: 1,
            startedAt: now,
            completedAt: now,
          },
          {
            id: "setup.check.github.token",
            kind: "diagnostic",
            status: "completed",
            attempts: 1,
            startedAt: now,
            completedAt: now,
          },
        ],
      })
    );

    try {
      await act(async () =>
        root.render(
          <IntegrationSetupFlow
            manifest={manifest}
            credentialType="github"
            manifestCredentialId="credential.github"
            onClose={() => {}}
            onCompleted={onCompleted}
          />
        )
      );
      await flushEffects();
      await act(async () =>
        setInputValue(
          container.querySelector('[aria-label="Access token"]') as HTMLInputElement,
          "secret"
        )
      );
      await act(async () => button(container, "Save and continue").click());
      await flushEffects();
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      await flushEffects();

      expect(discovery).toHaveBeenCalledTimes(2);
      expect(discovery).toHaveBeenNthCalledWith(1, "flow-1", {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 2,
        stepId: "setup.check.github.token",
      });
      expect(discovery).toHaveBeenNthCalledWith(2, "flow-1", {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 2,
        stepId: "setup.check.github.token",
      });
      expect(get).not.toHaveBeenCalled();
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("connected and ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["unknown", "failed"] as const)(
    "does not advance diagnostics from %s authorization state",
    async (authStatus) => {
      start.mockResolvedValue(
        snapshot({
          status: "discovering",
          authStatus,
          currentStepId: "setup.check.github.token",
          steps: [
            {
              id: "setup.check.github.token",
              kind: "diagnostic",
              status: "active",
              attempts: 1,
              startedAt: now,
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

      expect(discovery).not.toHaveBeenCalled();
    }
  );
  it("ignores an older overlapping OAuth refresh after accepting terminal progress", async () => {
    const awaitingOAuth = oauthSnapshot();
    let resolveOlder!: (value: IntegrationSetupFlowSnapshot) => void;
    let resolveNewer!: (value: IntegrationSetupFlowSnapshot) => void;
    start.mockResolvedValue(awaitingOAuth);
    get
      .mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveNewer = resolve)));
    const onCompleted = vi.fn();
    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={() => {}}
          onCompleted={onCompleted}
        />
      )
    );
    await flushEffects();
    const completion = { connectionId: "attempt", flowId: "flow-1", credentialId: "oauth-1" };
    const connected = (
      oauthButtonProps.mock.calls.at(-1)?.[0] as {
        onConnected: (value: typeof completion) => void;
      }
    ).onConnected;
    await act(async () => {
      connected(completion);
      connected(completion);
    });
    await act(async () =>
      resolveNewer(snapshot({ status: "completed", currentStepId: undefined, revision: 3 }))
    );
    await flushEffects();
    await act(async () => resolveOlder({ ...awaitingOAuth, revision: 2 }));
    await flushEffects();

    expect(container.textContent).toContain("connected and ready");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });
  it("keeps setup and OAuth account targets separate while resuming the exact flow", async () => {
    const awaitingOAuth = Object.assign(
      snapshot({
        mode: "reauthenticate",
        targetCredentialId: "setup-app-credential",
        status: "awaiting-oauth",
        authStatus: "reauthentication-required",
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
      }),
      { oauthCredentialId: "oauth-account-credential" }
    );
    const completed = Object.assign(
      snapshot({
        mode: "reauthenticate",
        targetCredentialId: "setup-app-credential",
        status: "completed",
        authStatus: "active",
        currentStepId: undefined,
        revision: 2,
        steps: [
          {
            id: "setup.oauth.github",
            kind: "oauth",
            status: "completed",
            attempts: 1,
            startedAt: now,
            completedAt: now,
          },
        ],
      }),
      { oauthCredentialId: "oauth-account-credential" }
    );
    start.mockResolvedValue(awaitingOAuth);
    get.mockResolvedValue(completed);

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          mode="reauthenticate"
          targetCredentialId="setup-app-credential"
          oauthCredentialId="oauth-account-credential"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCredentialId: "setup-app-credential",
        oauthCredentialId: "oauth-account-credential",
      })
    );
    const props = oauthButtonProps.mock.calls.at(-1)?.[0] as {
      provider: { id: string; method: string };
      flowId: string;
      flowRevision: number;
      oauthCredentialId: string;
      onConnected: (completion: {
        connectionId: string;
        flowId: string;
        credentialId: string;
      }) => void;
    };
    expect(props).toEqual(
      expect.objectContaining({
        flowId: "flow-1",
        flowRevision: 1,
        oauthCredentialId: "oauth-account-credential",
        provider: expect.objectContaining({ id: "github", method: "direct" }),
      })
    );
    await act(async () =>
      props.onConnected({
        connectionId: "oauth-attempt",
        flowId: "flow-1",
        credentialId: "oauth-account-credential",
      })
    );
    await flushEffects();

    expect(get).toHaveBeenCalledWith("flow-1");
    expect(container.textContent).toContain("connected and ready");
  });
  it("requires explicit acknowledgement before advancing an instruction step", async () => {
    const instructionManifest: IntegrationManifestV2 = {
      ...manifest,
      setup: [
        {
          id: "setup.instructions",
          kind: "instruction",
          title: "Prepare GitHub",
          instructions: "Enable organization access before continuing.",
        },
        ...manifest.setup,
      ],
    };
    start.mockResolvedValue(
      snapshot({
        currentStepId: "setup.instructions",
        steps: [
          {
            id: "setup.instructions",
            kind: "instruction",
            status: "active",
            attempts: 1,
            startedAt: now,
          },
        ],
      })
    );
    acknowledgeInstruction.mockResolvedValue(snapshot({ revision: 2 }));

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={instructionManifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={() => {}}
        />
      )
    );
    await flushEffects();

    expect(container.textContent).toContain("Enable organization access before continuing.");
    expect(container.querySelector('[aria-label="Access token"]')).toBeNull();
    await act(async () => button(container, "Continue").click());
    await flushEffects();

    expect(acknowledgeInstruction).toHaveBeenCalledWith("flow-1", {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 1,
      stepId: "setup.instructions",
    });
    await flushAnimationFrame();
    expect(document.activeElement).toBe(
      container.querySelector('[aria-label="Access token"]') as HTMLInputElement
    );
  });
  it("traps focus, restores it on unmount, and labels current step status", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open setup";
    document.body.appendChild(opener);
    opener.focus();
    start.mockResolvedValue(snapshot());

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
    await flushAnimationFrame();
    await flushEffects();

    const close = container.querySelector('[aria-label="Close setup"]') as HTMLButtonElement;
    const currentStep = container.querySelector('[aria-current="step"]') as HTMLElement;
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Access token"]'));
    expect(currentStep.textContent).toContain("Status: active");

    const cancelSetup = button(container, "Cancel setup");
    cancelSetup.focus();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    );
    expect(document.activeElement).toBe(close);

    await act(async () => root.render(<div />));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it("clears resume state and local secrets on completion", async () => {
    const onCompleted = vi.fn();
    const onClose = vi.fn();
    let resolveSubmit!: (value: IntegrationSetupFlowSnapshot) => void;
    start.mockResolvedValue(snapshot());
    submitCredentials.mockReturnValue(
      new Promise<IntegrationSetupFlowSnapshot>((resolve) => (resolveSubmit = resolve))
    );

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={onClose}
          onCompleted={onCompleted}
        />
      )
    );
    await flushEffects();
    await act(async () =>
      setInputValue(
        container.querySelector('[aria-label="Access token"]') as HTMLInputElement,
        "  one-use-secret  "
      )
    );
    await act(async () => button(container, "Save and continue").click());
    await flushEffects();
    expect(button(container, "Close and resume later").disabled).toBe(true);
    await act(async () => (container.firstElementChild as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () =>
      resolveSubmit(
        snapshot({
          status: "completed",
          authStatus: "active",
          currentStepId: undefined,
          revision: 2,
        })
      )
    );
    await flushEffects();
    await flushAnimationFrame();

    expect(submitCredentials).toHaveBeenCalledWith(
      "flow-1",
      expect.objectContaining({ data: { token: "  one-use-secret  " } })
    );
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(container.querySelector('[aria-label="Access token"]')).toBeNull();
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(container.querySelector("[data-setup-focus-status]"));
  });
  it("cancels with the current revision and clears resume state", async () => {
    const onClose = vi.fn();
    start.mockResolvedValue(snapshot());
    cancel.mockResolvedValue(snapshot({ status: "cancelled", revision: 2 }));

    await act(async () =>
      root.render(
        <IntegrationSetupFlow
          manifest={manifest}
          credentialType="github"
          manifestCredentialId="credential.github"
          onClose={onClose}
        />
      )
    );
    await flushEffects();
    await act(async () =>
      setInputValue(
        container.querySelector('[aria-label="Access token"]') as HTMLInputElement,
        "cancelled-secret"
      )
    );
    await act(async () => button(container, "Cancel setup").click());
    await flushEffects();

    expect(cancel).toHaveBeenCalledWith("flow-1", 1);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(JSON.stringify(window.localStorage)).not.toContain("cancelled-secret");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
