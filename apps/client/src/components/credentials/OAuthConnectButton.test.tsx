import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationAuthStatus, OAuthProviderDef } from "@chvor/shared";

const { initiate, disconnect, getSetup, fetchOAuthState, storeState } = vi.hoisted(() => ({
  initiate: vi.fn(),
  disconnect: vi.fn(),
  getSetup: vi.fn(),
  fetchOAuthState: vi.fn(),
  storeState: {
    credentials: [] as Array<{
      id: string;
      name: string;
      type: string;
      createdAt: string;
      redactedFields: Record<string, string>;
    }>,
    oauthConnections: [] as Array<{
      id: string;
      platform: string;
      status: string;
      method: string;
      connectedAt: string;
      credentialId?: string;
      authStatus?: IntegrationAuthStatus;
      needsReauthentication?: boolean;
    }>,
    fetchOAuthState: vi.fn(),
  },
}));

storeState.fetchOAuthState = fetchOAuthState;

vi.mock("@/lib/api", () => ({
  api: { oauth: { initiate, disconnect }, integrationSetup: { get: getSetup } },
}));

vi.mock("../../stores/feature-store", () => {
  const useFeatureStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  );
  return { useFeatureStore };
});

import { OAuthConnectButton } from "./OAuthConnectButton";

const provider: OAuthProviderDef = {
  id: "github",
  name: "GitHub",
  icon: "github",
  method: "direct",
  category: "developer",
  description: "GitHub OAuth",
};

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(container: HTMLElement): HTMLButtonElement {
  const result = container.querySelector("button");
  if (!result) throw new Error("Missing OAuth action");
  return result;
}

describe("OAuthConnectButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    storeState.credentials = [];
    storeState.oauthConnections = [];
    storeState.fetchOAuthState = fetchOAuthState;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it.each(["expired", "revoked", "reauthentication-required"] as IntegrationAuthStatus[])(
    "shows a clear reauthentication action for %s auth",
    async (authStatus) => {
      await act(async () =>
        root.render(
          <OAuthConnectButton
            provider={{ ...provider, connected: true, authStatus }}
            oauthCredentialId="credential-target"
            compact
          />
        )
      );

      expect(button(container).textContent).toBe("Reauthenticate");
      expect(container.textContent).toContain("Authorization expired");
      expect(container.textContent).not.toContain("Connected");
    }
  );

  it("shows Connected only for active authorization", async () => {
    await act(async () =>
      root.render(
        <OAuthConnectButton provider={{ ...provider, connected: true, authStatus: "active" }} />
      )
    );

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).not.toContain("Reauthenticate");
  });

  it("keeps an already-connected provider actionable inside an exact durable flow", async () => {
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "connection-current",
      flowId: "flow-current",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(
        <OAuthConnectButton
          provider={{ ...provider, connected: true, authStatus: "active" }}
          flowId="flow-current"
        />
      )
    );

    expect(container.textContent).not.toContain("Authorized. Continuing setup");
    expect(button(container).textContent).toBe("Connect");
    await act(async () => button(container).click());
    await flushEffects();
    expect(initiate).toHaveBeenCalledWith("github", { flowId: "flow-current" });
  });

  it("does not reuse an active connection as durable-flow completion", async () => {
    storeState.oauthConnections = [
      {
        id: "connection-existing",
        platform: "github",
        method: "direct",
        status: "active",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "oauth-existing",
        authStatus: "active",
      },
    ];
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "connection-current",
      flowId: "flow-current",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-current" />)
    );

    expect(container.textContent).not.toContain("Authorized. Continuing setup");
    expect(button(container).textContent).toBe("Connect");
    await act(async () => button(container).click());
    await flushEffects();
    expect(initiate).toHaveBeenCalledWith("github", { flowId: "flow-current" });
  });

  it("routes standalone direct reauthentication back to manifest setup", async () => {
    storeState.oauthConnections = [
      {
        id: "connection-record-existing",
        platform: "github",
        method: "direct",
        status: "failed",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "credential-existing",
        authStatus: "reauthentication-required",
        needsReauthentication: true,
      },
    ];
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "connection-reauth",
      flowId: "flow-server-created",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () => root.render(<OAuthConnectButton provider={provider} />));
    expect(button(container).textContent).toBe("Reauthenticate");
    await act(async () => button(container).click());
    await flushEffects();

    expect(initiate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("started from the integration catalog");
  });

  it("uses connection identity for disconnect while retaining the OAuth credential identity", async () => {
    storeState.oauthConnections = [
      {
        id: "connection-record-active",
        platform: "github",
        method: "direct",
        status: "active",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "oauth-credential-active",
        authStatus: "active",
      },
    ];

    await act(async () => root.render(<OAuthConnectButton provider={provider} />));
    await act(async () => button(container).click());
    await flushEffects();

    expect(disconnect).toHaveBeenCalledWith("connection-record-active");
  });

  it("passes both durable flow and credential ids for an in-flow reauthentication", async () => {
    const onConnected = vi.fn();
    storeState.oauthConnections = [
      {
        id: "credential-existing",
        platform: "github",
        method: "direct",
        status: "failed",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "credential-existing",
        authStatus: "revoked",
        needsReauthentication: true,
      },
    ];
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "connection-reauth",
      flowId: "flow-reauth",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(
        <OAuthConnectButton
          provider={provider}
          flowId="flow-reauth"
          oauthCredentialId="credential-existing"
          onConnected={onConnected}
        />
      )
    );
    await act(async () => button(container).click());
    await flushEffects();

    expect(initiate).toHaveBeenCalledWith("github", {
      flowId: "flow-reauth",
      oauthCredentialId: "credential-existing",
    });

    const callback = {
      type: "chvor-oauth-callback",
      success: true,
      connectionId: "connection-reauth",
      flowId: "flow-reauth",
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { ...callback, credentialId: "credential-other" },
          origin: window.location.origin,
          source: window,
        })
      );
    });
    expect(onConnected).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { ...callback, credentialId: "credential-existing" },
          origin: window.location.origin,
          source: window,
        })
      );
    });
    expect(onConnected).toHaveBeenCalledWith({
      connectionId: "connection-reauth",
      credentialId: "credential-existing",
      flowId: "flow-reauth",
    });
  });

  it("rejects spoofed, stale, and unrelated popup callback messages", async () => {
    const onConnected = vi.fn();
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "connection-current",
      flowId: "setup-flow-current",
      callbackOrigin: "https://oauth-callback.example",
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(popup);

    await act(async () =>
      root.render(
        <OAuthConnectButton
          provider={provider}
          flowId="setup-flow-current"
          onConnected={onConnected}
        />
      )
    );
    await act(async () => button(container).click());
    await flushEffects();
    expect(initiate).toHaveBeenCalledWith("github", { flowId: "setup-flow-current" });
    expect(container.textContent).toContain("Waiting");

    const dispatch = (
      data: Record<string, unknown>,
      origin = window.location.origin,
      source: Window | null = popup
    ) => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    };
    const base = {
      type: "chvor-oauth-callback",
      success: true,
      connectionId: "connection-current",
      credentialId: "credential-created-after-callback",
      flowId: "setup-flow-current",
    };

    await act(async () => {
      dispatch(base, "https://attacker.example");
      dispatch(base, window.location.origin);
      dispatch(base, window.location.origin, null);
      dispatch({ ...base, connectionId: "connection-stale" }, "https://oauth-callback.example");
      dispatch({ ...base, flowId: "setup-flow-unrelated" }, "https://oauth-callback.example");
    });
    expect(onConnected).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Waiting");

    await act(async () => dispatch(base, "https://oauth-callback.example"));
    await flushEffects();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledWith({
      connectionId: "connection-current",
      credentialId: "credential-created-after-callback",
      flowId: "setup-flow-current",
    });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Authorized. Continuing setup");
  });

  it("keeps the active popup attempt when the connected callback prop changes", async () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "connection-current",
      flowId: "setup-flow-current",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(
        <OAuthConnectButton
          provider={provider}
          flowId="setup-flow-current"
          onConnected={firstCallback}
        />
      )
    );
    await act(async () => button(container).click());
    await flushEffects();
    await act(async () =>
      root.render(
        <OAuthConnectButton
          provider={provider}
          flowId="setup-flow-current"
          onConnected={latestCallback}
        />
      )
    );
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data: {
            type: "chvor-oauth-callback",
            success: true,
            connectionId: "connection-current",
            flowId: "setup-flow-current",
            credentialId: "credential-created",
          },
        })
      )
    );

    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).toHaveBeenCalledWith({
      connectionId: "connection-current",
      flowId: "setup-flow-current",
      credentialId: "credential-created",
    });
  });

  it("does not open a popup when initiation resolves after teardown", async () => {
    let resolveInitiation!: (value: {
      redirectUrl: string;
      connectionId: string;
      flowId: string;
      callbackOrigin: string;
      method: "direct";
    }) => void;
    initiate.mockReturnValue(
      new Promise((resolve) => {
        resolveInitiation = resolve;
      })
    );
    const open = vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-current" />)
    );
    await act(async () => button(container).click());
    expect(container.textContent).toContain("Starting");

    await act(async () => root.render(<></>));
    await act(async () =>
      resolveInitiation({
        redirectUrl: "https://github.example/stale",
        connectionId: "connection-stale",
        flowId: "flow-current",
        callbackOrigin: window.location.origin,
        method: "direct",
      })
    );
    await flushEffects();

    expect(open).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight initiation before retrying for a new flow", async () => {
    let resolveFirstInitiation!: (value: {
      redirectUrl: string;
      connectionId: string;
      flowId: string;
      callbackOrigin: string;
      method: "direct";
    }) => void;
    initiate
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstInitiation = resolve;
          })
      )
      .mockResolvedValueOnce({
        redirectUrl: "https://github.example/current",
        connectionId: "connection-current",
        flowId: "flow-current",
        callbackOrigin: window.location.origin,
        method: "direct",
      });
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-stale" />)
    );
    await act(async () => button(container).click());
    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-current" />)
    );
    expect(button(container).textContent).toBe("Connect");

    await act(async () => button(container).click());
    await flushEffects();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://github.example/current",
      "_blank",
      "width=600,height=700"
    );

    await act(async () =>
      resolveFirstInitiation({
        redirectUrl: "https://github.example/stale",
        connectionId: "connection-stale",
        flowId: "flow-stale",
        callbackOrigin: window.location.origin,
        method: "direct",
      })
    );
    await flushEffects();

    expect(open).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Waiting");
  });

  it("closes the active popup and ignores callbacks after teardown", async () => {
    const onConnected = vi.fn();
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/current",
      connectionId: "connection-current",
      flowId: "flow-current",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(popup);

    await act(async () =>
      root.render(
        <OAuthConnectButton provider={provider} flowId="flow-current" onConnected={onConnected} />
      )
    );
    await act(async () => button(container).click());
    await flushEffects();
    await act(async () => root.render(<></>));

    expect(popup.close).toHaveBeenCalledTimes(1);
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: popup,
          data: {
            type: "chvor-oauth-callback",
            success: true,
            connectionId: "connection-current",
            flowId: "flow-current",
            credentialId: "credential-created",
          },
        })
      )
    );
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("requires an explicit choice but does not reauthenticate it outside a manifest flow", async () => {
    storeState.oauthConnections = [
      {
        id: "credential-first",
        platform: "github",
        method: "direct",
        status: "failed",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "credential-first",
        authStatus: "revoked",
        needsReauthentication: true,
      },
      {
        id: "credential-second",
        platform: "github",
        method: "direct",
        status: "failed",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "credential-second",
        authStatus: "expired",
        needsReauthentication: true,
      },
    ];
    initiate.mockResolvedValue({
      redirectUrl: "https://github.example/authorize",
      connectionId: "attempt-second",
      flowId: "flow-server-created",
      callbackOrigin: window.location.origin,
      method: "direct",
    });
    vi.spyOn(window, "open").mockReturnValue(window);
    await act(async () =>
      root.render(<OAuthConnectButton provider={{ ...provider, needsReauthentication: true }} />)
    );

    expect(button(container).textContent).toBe("Choose account");
    expect(button(container).disabled).toBe(true);
    expect(initiate).not.toHaveBeenCalled();
    const picker = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        picker,
        "credential-second"
      );
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(container).click());
    await flushEffects();

    expect(initiate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("started from the integration catalog");
  });

  it("clears a prior account choice when the durable attempt identity changes", async () => {
    storeState.oauthConnections = [
      {
        id: "connection-first",
        platform: "github",
        method: "direct",
        status: "failed",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "credential-first",
        authStatus: "revoked",
        needsReauthentication: true,
      },
      {
        id: "connection-second",
        platform: "github",
        method: "direct",
        status: "failed",
        connectedAt: "2026-07-13T10:00:00.000Z",
        credentialId: "credential-second",
        authStatus: "expired",
        needsReauthentication: true,
      },
    ];

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-first" />)
    );
    const picker = container.querySelector(
      'select[aria-label="OAuth account for GitHub"]'
    ) as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        picker,
        "connection-second"
      );
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picker.value).toBe("connection-second");

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-first" />)
    );
    await flushEffects();
    expect(
      (
        container.querySelector(
          'select[aria-label="OAuth account for GitHub"]'
        ) as HTMLSelectElement
      ).value
    ).toBe("connection-second");

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-second" />)
    );
    await flushEffects();

    const currentPicker = container.querySelector(
      'select[aria-label="OAuth account for GitHub"]'
    ) as HTMLSelectElement;
    expect(currentPicker.value).toBe("");
    expect(button(container).textContent).toBe("Choose account");
    expect(button(container).disabled).toBe(true);
    expect(initiate).not.toHaveBeenCalled();
  });

  it("clears an account choice when the matching candidate identity changes", async () => {
    const connection = (id: string, credentialId: string) => ({
      id,
      platform: "github",
      method: "direct",
      status: "failed",
      connectedAt: "2026-07-13T10:00:00.000Z",
      credentialId,
      authStatus: "revoked" as const,
      needsReauthentication: true,
    });
    storeState.oauthConnections = [
      connection("connection-first", "credential-first"),
      connection("connection-second", "credential-second"),
    ];
    await act(async () => root.render(<OAuthConnectButton provider={provider} />));
    const picker = container.querySelector(
      'select[aria-label="OAuth account for GitHub"]'
    ) as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        picker,
        "connection-second"
      );
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    storeState.oauthConnections = [
      connection("connection-first", "credential-first"),
      connection("connection-third", "credential-third"),
    ];
    await act(async () => root.render(<OAuthConnectButton provider={provider} />));
    await flushEffects();

    expect(
      (
        container.querySelector(
          'select[aria-label="OAuth account for GitHub"]'
        ) as HTMLSelectElement
      ).value
    ).toBe("");
    expect(button(container).textContent).toBe("Choose account");
    expect(button(container).disabled).toBe(true);
  });

  it("selects one of multiple direct OAuth app credentials before retrying initiation", async () => {
    storeState.credentials = [
      {
        id: "github-app-personal",
        name: "Personal GitHub App",
        type: "github-oauth-app",
        createdAt: "2026-07-13T10:00:00.000Z",
        redactedFields: {},
      },
      {
        id: "github-app-work",
        name: "Work GitHub App",
        type: "github-oauth-app",
        createdAt: "2026-07-13T10:00:00.000Z",
        redactedFields: {},
      },
    ];
    initiate
      .mockRejectedValueOnce(
        Object.assign(new Error("Multiple OAuth app credentials are available."), {
          status: 409,
          code: "oauth_app_credential_selection_required",
          candidateCredentialIds: ["github-app-personal", "github-app-work"],
        })
      )
      .mockResolvedValueOnce({
        redirectUrl: "https://github.example/authorize",
        connectionId: "connection-current",
        callbackOrigin: window.location.origin,
        method: "direct",
      });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () => root.render(<OAuthConnectButton provider={provider} />));
    await act(async () => button(container).click());
    await flushEffects();

    const picker = container.querySelector(
      'select[aria-label="OAuth app credentials for GitHub"]'
    ) as HTMLSelectElement;
    expect(picker).not.toBeNull();
    expect(picker.required).toBe(true);
    expect(picker.textContent).toContain("Work GitHub App — github-app-work");
    expect(button(container).textContent).toBe("Choose app credentials");
    expect(button(container).disabled).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        picker,
        "github-app-work"
      );
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button(container).click());
    await flushEffects();

    expect(initiate).toHaveBeenNthCalledWith(1, "github", {});
    expect(initiate).toHaveBeenNthCalledWith(2, "github", {
      appCredentialId: "github-app-work",
    });
  });

  it("does not carry a selected OAuth app credential into a different durable flow", async () => {
    initiate
      .mockRejectedValueOnce(
        Object.assign(new Error("Multiple OAuth app credentials are available."), {
          status: 409,
          code: "oauth_app_credential_selection_required",
          candidateCredentialIds: ["github-app-personal", "github-app-work"],
        })
      )
      .mockResolvedValueOnce({
        redirectUrl: "https://github.example/authorize",
        connectionId: "connection-next",
        flowId: "flow-next",
        callbackOrigin: window.location.origin,
        method: "direct",
      });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () => root.render(<OAuthConnectButton provider={provider} />));
    await act(async () => button(container).click());
    await flushEffects();

    const picker = container.querySelector(
      'select[aria-label="OAuth app credentials for GitHub"]'
    ) as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        picker,
        "github-app-work"
      );
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () =>
      root.render(<OAuthConnectButton provider={provider} flowId="flow-next" />)
    );
    await flushEffects();
    expect(
      container.querySelector('select[aria-label="OAuth app credentials for GitHub"]')
    ).toBeNull();

    await act(async () => button(container).click());
    await flushEffects();
    expect(initiate).toHaveBeenNthCalledWith(2, "github", { flowId: "flow-next" });
  });

  it.each([
    ["exact completion", "setup-flow", "oauth-target", 5, 1],
    ["different flow", "other-flow", "oauth-target", 5, 0],
    ["different OAuth target", "setup-flow", "oauth-other", 5, 0],
    ["unchanged revision", "setup-flow", "oauth-target", 4, 0],
  ] as const)(
    "popup-close fallback accepts %s only after exact durable verification",
    async (_case, returnedFlowId, returnedOAuthCredentialId, revision, expectedCalls) => {
      vi.useFakeTimers();
      const onConnected = vi.fn();
      initiate.mockResolvedValue({
        redirectUrl: "https://github.example/authorize",
        connectionId: "oauth-attempt",
        flowId: "setup-flow",
        oauthCredentialId: "oauth-target",
        callbackOrigin: "https://oauth-callback.example",
        method: "direct",
      });
      getSetup.mockResolvedValue({
        id: returnedFlowId,
        revision,
        authStatus: "active",
        status: "completed",
        oauthCredentialId: returnedOAuthCredentialId,
      });
      vi.spyOn(window, "open").mockReturnValue({ closed: true } as Window);

      try {
        await act(async () =>
          root.render(
            <OAuthConnectButton
              provider={provider}
              flowId="setup-flow"
              flowRevision={4}
              oauthCredentialId="oauth-target"
              onConnected={onConnected}
            />
          )
        );
        await act(async () => button(container).click());
        await flushEffects();
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        await act(async () => vi.advanceTimersByTimeAsync(1500));
        await flushEffects();

        expect(getSetup).toHaveBeenCalledWith("setup-flow");
        expect(onConnected).toHaveBeenCalledTimes(expectedCalls);
        if (expectedCalls === 1) {
          expect(onConnected).toHaveBeenCalledWith({
            connectionId: "oauth-attempt",
            flowId: "setup-flow",
            credentialId: "oauth-target",
          });
        }
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("fails closed when a broker does not retain the supplied durable flow", async () => {
    const broker = { ...provider, method: "composio" as const };
    initiate.mockResolvedValue({
      redirectUrl: "https://broker.example/connect",
      connectionId: "broker-attempt",
      callbackOrigin: window.location.origin,
      method: "composio",
    });
    const open = vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(<OAuthConnectButton provider={broker} flowId="flow-broker" />)
    );
    await act(async () => button(container).click());
    await flushEffects();

    expect(initiate).toHaveBeenCalledWith("github", { flowId: "flow-broker" });
    expect(open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("did not retain this durable setup flow");
  });

  it("offers only an explicit new-account action for manifest-bound broker setup", async () => {
    const broker = { ...provider, method: "composio" as const };
    storeState.oauthConnections = ["existing-one", "existing-two"].map((id) => ({
      id,
      platform: "github",
      method: "composio",
      status: "active",
      connectedAt: "2026-07-13T10:00:00.000Z",
      authStatus: "active" as const,
    }));
    initiate.mockResolvedValue({
      redirectUrl: "https://broker.example/connect",
      connectionId: "broker-new",
      flowId: "flow-broker",
      callbackOrigin: window.location.origin,
      method: "composio",
    });
    vi.spyOn(window, "open").mockReturnValue(window);

    await act(async () =>
      root.render(<OAuthConnectButton provider={broker} flowId="flow-broker" />)
    );

    expect(container.querySelector('select[aria-label="OAuth account for GitHub"]')).toBeNull();
    expect(button(container).textContent).toBe("Connect new account");
    expect(container.textContent).toContain("Creates a new account connection via Composio");
    await act(async () => button(container).click());
    await flushEffects();
    expect(initiate).toHaveBeenCalledWith("github", { flowId: "flow-broker" });
  });

  it("accepts an exact completed broker flow after the popup closes without a message", async () => {
    vi.useFakeTimers();
    const broker = { ...provider, method: "composio" as const };
    const onConnected = vi.fn();
    initiate.mockResolvedValue({
      redirectUrl: "https://broker.example/connect",
      connectionId: "broker-attempt",
      flowId: "flow-broker",
      callbackOrigin: window.location.origin,
      method: "composio",
    });
    getSetup.mockResolvedValue({
      id: "flow-broker",
      revision: 6,
      authStatus: "active",
      status: "completed",
    });
    vi.spyOn(window, "open").mockReturnValue({ closed: true } as Window);

    try {
      await act(async () =>
        root.render(
          <OAuthConnectButton
            provider={broker}
            flowId="flow-broker"
            flowRevision={5}
            onConnected={onConnected}
          />
        )
      );
      await act(async () => button(container).click());
      await flushEffects();
      await act(async () => vi.advanceTimersByTimeAsync(2_500));

      expect(onConnected).toHaveBeenCalledWith({
        connectionId: "broker-attempt",
        flowId: "flow-broker",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
