import { afterEach, describe, expect, it, vi } from "vitest";
const { setAuthenticated } = vi.hoisted(() => ({ setAuthenticated: vi.fn() }));

vi.mock("../stores/session-store", () => ({
  useSessionStore: { getState: () => ({ setAuthenticated }) },
}));

import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthenticated.mockReset();
});

describe("OAuth API", () => {
  it("ties a direct authorization attempt to the requested durable flow", async () => {
    const result = {
      redirectUrl: "https://provider.example/authorize",
      connectionId: "oauth-state",
      flowId: "flow-1",
      callbackOrigin: "https://callback.example",
      method: "direct",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: result }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.oauth.initiate("github", { flowId: "flow-1" })).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/initiate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "github",
          flowId: "flow-1",
        }),
      })
    );
  });

  it("keeps the OAuth account target separate from setup credential targets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: {
          redirectUrl: "https://provider.example/authorize",
          connectionId: "oauth-state",
          flowId: "flow-1",
          oauthCredentialId: "oauth-credential-1",
          callbackOrigin: "https://callback.example",
          method: "direct",
        },
      }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await api.oauth.initiate("github", {
      flowId: "flow-1",
      oauthCredentialId: "oauth-credential-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/initiate",
      expect.objectContaining({
        body: JSON.stringify({
          provider: "github",
          flowId: "flow-1",
          oauthCredentialId: "oauth-credential-1",
        }),
      })
    );
  });

  it("passes an explicitly selected direct OAuth app credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: {
          redirectUrl: "https://provider.example/authorize",
          connectionId: "oauth-state",
          flowId: "flow-1",
          callbackOrigin: "https://callback.example",
          method: "direct",
        },
      }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await api.oauth.initiate("github", {
      flowId: "flow-1",
      appCredentialId: "github-app-work",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/initiate",
      expect.objectContaining({
        body: JSON.stringify({
          provider: "github",
          flowId: "flow-1",
          appCredentialId: "github-app-work",
        }),
      })
    );
  });

  it.each([401, 422])(
    "does not log out the Chvor session for terminal provider refresh status %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status,
          ok: false,
          json: vi.fn().mockResolvedValue({
            error: "OAuth authorization is no longer valid.",
            needsReauthentication: true,
            credentialId: "oauth-credential-1",
            failureCode: "oauth_refresh_revoked",
          }),
        } satisfies Partial<Response>)
      );

      await expect(api.oauth.refresh("oauth-credential-1")).rejects.toMatchObject({
        status,
        needsReauthentication: true,
        credentialId: "oauth-credential-1",
        failureCode: "oauth_refresh_revoked",
      });
      expect(setAuthenticated).not.toHaveBeenCalled();
    }
  );

  it("still logs out for an actual API session 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: "Unauthorized" }),
      } satisfies Partial<Response>)
    );

    await expect(api.oauth.connections()).rejects.toMatchObject({
      status: 401,
      message: "Session expired",
    });
    expect(setAuthenticated).toHaveBeenCalledWith(false);
  });
});
