import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  generateAuthUrl,
  generateCodeVerifier,
  generateCodeChallenge,
  getPendingFlow,
  exchangeCode,
  refreshAccessToken,
  type OAuthProviderConfig,
  type PendingOAuthFlow,
} from "../oauth-engine.ts";

const provider: OAuthProviderConfig = {
  id: "demo",
  name: "Demo",
  authUrl: "https://demo.test/authorize",
  tokenUrl: "https://demo.test/token",
  scopes: ["read", "write"],
  extraAuthParams: { access_type: "offline" },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("PKCE", () => {
  it("code challenge is the base64url SHA-256 of the verifier", () => {
    const verifier = generateCodeVerifier();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(generateCodeChallenge(verifier)).toBe(expected);
  });

  it("verifier is within RFC length bounds and unreserved charset", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("generateAuthUrl", () => {
  it("builds a PKCE auth URL and stores the pending flow under the state", () => {
    const { authUrl, state } = generateAuthUrl(
      provider,
      "client-123",
      "secret-xyz",
      "http://localhost:9147/api/oauth/callback"
    );
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe("https://demo.test/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("read write");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline"); // extraAuthParams
    expect(u.searchParams.get("state")).toBe(state);

    const flow = getPendingFlow(state);
    expect(flow?.clientId).toBe("client-123");
    expect(flow?.clientSecret).toBe("secret-xyz");
    // the stored verifier must hash to the challenge in the URL
    expect(generateCodeChallenge(flow!.codeVerifier)).toBe(
      u.searchParams.get("code_challenge")
    );
  });
});

describe("exchangeCode", () => {
  const flow: PendingOAuthFlow = {
    providerId: "demo",
    codeVerifier: "verifier-abc",
    state: "state-1",
    clientId: "client-123",
    clientSecret: "secret-xyz",
    redirectUri: "http://localhost:9147/api/oauth/callback",
    createdAt: Date.now(),
  };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("posts an authorization_code grant with PKCE verifier + secret and parses tokens", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read write",
        })
      );

    const tokens = await exchangeCode(provider, "the-code", flow);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://demo.test/token");
    const sent = new URLSearchParams(init!.body as string);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("the-code");
    expect(sent.get("code_verifier")).toBe("verifier-abc");
    expect(sent.get("client_id")).toBe("client-123");
    expect(sent.get("client_secret")).toBe("secret-xyz");

    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.expiresAt).toBeDefined();
    expect(new Date(tokens.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("uses HTTP Basic auth for reddit token exchange", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ access_token: "at" }));
    await exchangeCode({ ...provider, id: "reddit" }, "c", flow);
    const init = fetchMock.mock.calls[0][1]!;
    const auth = (init.headers as Record<string, string>)["Authorization"];
    expect(auth).toBe(`Basic ${Buffer.from("client-123:secret-xyz").toString("base64")}`);
  });

  it("throws with status + body on a non-ok exchange", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_grant" }, false, 400)
    );
    await expect(exchangeCode(provider, "bad", flow)).rejects.toThrow(/400/);
  });
});

describe("refreshAccessToken", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("posts a refresh_token grant and returns the new access token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 })
      );

    const tokens = await refreshAccessToken(provider, "rt-1", "client-123", "secret-xyz");
    const sent = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("rt-1");
    expect(tokens.accessToken).toBe("at-2");
    expect(tokens.refreshToken).toBe("rt-2");
  });

  it("preserves the old refresh token when the provider omits a new one", async () => {
    // Regression: a rotated access token must not blank out the refresh token
    // just because the response didn't echo one back.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "at-2", expires_in: 3600 })
    );
    const tokens = await refreshAccessToken(provider, "rt-original", "client-123");
    expect(tokens.accessToken).toBe("at-2");
    expect(tokens.refreshToken).toBe("rt-original");
  });

  it("throws on a failed refresh", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "invalid_grant" }, false, 401)
    );
    await expect(refreshAccessToken(provider, "rt", "c")).rejects.toThrow(/401/);
  });
});
