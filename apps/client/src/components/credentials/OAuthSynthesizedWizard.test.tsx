import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthSynthesizedWizardData } from "@chvor/shared";

const { synthesizedRedirectUrl, synthesizedInitiate, getIntegrationSetup, cancelIntegrationSetup } =
  vi.hoisted(() => ({
    synthesizedRedirectUrl: vi.fn(),
    synthesizedInitiate: vi.fn(),
    getIntegrationSetup: vi.fn(),
    cancelIntegrationSetup: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  api: {
    oauth: { synthesizedRedirectUrl, synthesizedInitiate },
    integrationSetup: { get: getIntegrationSetup, cancel: cancelIntegrationSetup },
  },
}));

import { OAuthSynthesizedWizard } from "./OAuthSynthesizedWizard";

const request: OAuthSynthesizedWizardData = {
  requestId: "request-1",
  credentialType: "custom-oauth",
  providerName: "Custom OAuth",
  authUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  scopes: ["read"],
  timestamp: "2026-07-13T10:00:00.000Z",
};

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!result) throw new Error(`Missing ${label} button`);
  return result;
}

function stepHeading(container: HTMLElement): HTMLHeadingElement {
  const result = container.querySelector<HTMLHeadingElement>("[data-oauth-wizard-step-heading]");
  if (!result) throw new Error("Missing OAuth wizard step heading");
  return result;
}

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

describe("OAuthSynthesizedWizard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    synthesizedRedirectUrl.mockResolvedValue({
      redirectUrl: `${window.location.origin}/api/oauth/callback`,
    });
    synthesizedInitiate.mockResolvedValue({
      redirectUrl: "https://provider.example/consent",
      connectionId: "attempt-current",
      flowId: "flow-current",
      callbackOrigin: window.location.origin,
      method: "direct",
      redirectUriUsed: `${window.location.origin}/api/oauth/callback`,
    });
    getIntegrationSetup.mockResolvedValue({
      id: "flow-current",
      revision: 4,
      status: "awaiting-oauth",
      authStatus: "unknown",
    });
    cancelIntegrationSetup.mockResolvedValue({
      id: "flow-current",
      revision: 5,
      status: "cancelled",
      authStatus: "unknown",
    });
    vi.spyOn(window, "open").mockReturnValue(window);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("announces step changes and moves focus without interrupting credential input", async () => {
    const onComplete = vi.fn();
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    await act(async () =>
      root.render(
        <OAuthSynthesizedWizard request={request} onComplete={onComplete} onCancel={() => {}} />
      )
    );
    await flushEffects();
    expect(container.querySelector("h3")?.textContent).toContain("Connect Custom OAuth");

    await act(async () => button(container, "registered it").click());
    expect(stepHeading(container).textContent).toContain("Step 2 of 3");
    expect(document.activeElement).toBe(stepHeading(container));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Step 2 of 3");

    const clientIdInput = Array.from(container.querySelectorAll("input")).find((input) =>
      input.previousElementSibling?.textContent?.includes("Client ID")
    ) as HTMLInputElement;
    clientIdInput.focus();
    await act(async () => setInputValue(clientIdInput, "client-id"));
    expect(document.activeElement).toBe(clientIdInput);

    await act(async () => button(container, "Launch consent").click());
    await flushEffects();
    expect(stepHeading(container).textContent).toContain("Step 3 of 3");
    expect(document.activeElement).toBe(stepHeading(container));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Step 3 of 3");

    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "chvor-oauth-callback",
            success: true,
            connectionId: "attempt-current",
            credentialId: "credential-created",
            flowId: "flow-current",
          },
          origin: window.location.origin,
          source: popup,
        })
      )
    );
    expect(stepHeading(container).textContent).toBe("Connected!");
    expect(document.activeElement).toBe(stepHeading(container));
    expect(onComplete).toHaveBeenCalledWith(true);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("accepts only the opened popup and current connection attempt", async () => {
    const onComplete = vi.fn();
    await act(async () =>
      root.render(
        <OAuthSynthesizedWizard request={request} onComplete={onComplete} onCancel={() => {}} />
      )
    );
    await flushEffects();
    await act(async () => button(container, "registered it").click());
    await act(async () => {
      setInputValue(
        Array.from(container.querySelectorAll("input")).find((input) =>
          input.previousElementSibling?.textContent?.includes("Client ID")
        ) as HTMLInputElement,
        "client-id"
      );
    });
    await act(async () => button(container, "Launch consent").click());
    await flushEffects();

    const message = {
      type: "chvor-oauth-callback",
      success: true,
      connectionId: "attempt-current",
      credentialId: "credential-created",
      flowId: "flow-current",
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: message,
          origin: "https://attacker.example",
          source: window,
        })
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { ...message, connectionId: "attempt-stale" },
          origin: window.location.origin,
          source: window,
        })
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { ...message, flowId: "flow-stale" },
          origin: window.location.origin,
          source: window,
        })
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: message,
          origin: window.location.origin,
          source: null,
        })
      );
    });
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: message,
          origin: window.location.origin,
          source: window,
        })
      )
    );
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it.each([
    ["completed exact flow", "flow-current", "credential-created", "completed", "active", 1],
    ["different flow", "flow-other", "credential-created", "completed", "active", 0],
    ["missing credential", "flow-current", undefined, "completed", "active", 0],
    ["still awaiting OAuth", "flow-current", "credential-created", "awaiting-oauth", "unknown", 0],
  ] as const)(
    "verifies popup-close fallback against the %s",
    async (_case, returnedFlowId, credentialId, status, authStatus, expectedCalls) => {
      vi.useFakeTimers();
      const onComplete = vi.fn();
      vi.spyOn(window, "open").mockReturnValue({ closed: true } as Window);
      getIntegrationSetup.mockResolvedValue({
        id: returnedFlowId,
        oauthCredentialId: credentialId,
        status,
        authStatus,
      });

      try {
        await act(async () =>
          root.render(
            <OAuthSynthesizedWizard request={request} onComplete={onComplete} onCancel={() => {}} />
          )
        );
        await flushEffects();
        await act(async () => button(container, "registered it").click());
        await act(async () => {
          setInputValue(
            Array.from(container.querySelectorAll("input")).find((input) =>
              input.previousElementSibling?.textContent?.includes("Client ID")
            ) as HTMLInputElement,
            "client-id"
          );
        });
        await act(async () => button(container, "Launch consent").click());
        await flushEffects();
        await act(async () => vi.advanceTimersByTimeAsync(2_500));

        expect(onComplete).toHaveBeenCalledTimes(expectedCalls);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("cancels the exact durable flow when the synthesized popup is blocked", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    await act(async () =>
      root.render(
        <OAuthSynthesizedWizard request={request} onComplete={() => {}} onCancel={() => {}} />
      )
    );
    await flushEffects();
    await act(async () => button(container, "registered it").click());
    await act(async () => {
      setInputValue(
        Array.from(container.querySelectorAll("input")).find((input) =>
          input.previousElementSibling?.textContent?.includes("Client ID")
        ) as HTMLInputElement,
        "client-id"
      );
    });
    await act(async () => button(container, "Launch consent").click());
    await flushEffects();

    await vi.waitFor(() => {
      expect(getIntegrationSetup).toHaveBeenCalledWith("flow-current");
      expect(cancelIntegrationSetup).toHaveBeenCalledWith("flow-current", 4);
    });
    expect(container.textContent).toContain("popup was blocked");
    expect(stepHeading(container).textContent).toBe("Something went wrong");
    expect(document.activeElement).toBe(stepHeading(container));

    await act(async () => button(container, "Try again").click());
    expect(stepHeading(container).textContent).toContain("Step 2 of 3");
    expect(document.activeElement).toBe(stepHeading(container));
  });

  it("cancels with CAS and ignores a delayed success callback after explicit cancel", async () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    await act(async () =>
      root.render(
        <OAuthSynthesizedWizard request={request} onComplete={onComplete} onCancel={onCancel} />
      )
    );
    await flushEffects();
    await act(async () => button(container, "registered it").click());
    await act(async () => {
      setInputValue(
        Array.from(container.querySelectorAll("input")).find((input) =>
          input.previousElementSibling?.textContent?.includes("Client ID")
        ) as HTMLInputElement,
        "client-id"
      );
    });
    await act(async () => button(container, "Launch consent").click());
    await flushEffects();
    await act(async () => button(container, "Cancel").click());

    await vi.waitFor(() => {
      expect(cancelIntegrationSetup).toHaveBeenCalledWith("flow-current", 4);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);

    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "chvor-oauth-callback",
            success: true,
            connectionId: "attempt-current",
            credentialId: "credential-created",
            flowId: "flow-current",
          },
          origin: window.location.origin,
          source: popup,
        })
      )
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("cancels the durable server flow when the active wizard is torn down", async () => {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    await act(async () =>
      root.render(
        <OAuthSynthesizedWizard request={request} onComplete={() => {}} onCancel={() => {}} />
      )
    );
    await flushEffects();
    await act(async () => button(container, "registered it").click());
    await act(async () => {
      setInputValue(
        Array.from(container.querySelectorAll("input")).find((input) =>
          input.previousElementSibling?.textContent?.includes("Client ID")
        ) as HTMLInputElement,
        "client-id"
      );
    });
    await act(async () => button(container, "Launch consent").click());
    await flushEffects();
    await act(async () => root.render(<></>));

    await vi.waitFor(() => {
      expect(cancelIntegrationSetup).toHaveBeenCalledWith("flow-current", 4);
    });
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});
