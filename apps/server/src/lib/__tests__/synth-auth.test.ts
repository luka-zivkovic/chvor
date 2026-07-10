import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "@chvor/shared";
import {
  applyAuth,
  buildUrl,
  resolvePrimarySecret,
  stripCrlf,
} from "../synthesized/auth.ts";

function apply(
  auth: ConnectionConfig["auth"],
  data: Record<string, string>,
  urlStr = "https://api.example.com/v1/thing"
): { headers: Record<string, string>; url: URL } {
  const headers: Record<string, string> = {};
  const url = new URL(urlStr);
  applyAuth(headers, url, auth, data);
  return { headers, url };
}

describe("applyAuth — scheme coverage", () => {
  it("bearer uses default `Bearer <key>` template", () => {
    const { headers } = apply({ scheme: "bearer" }, { apiKey: "sk-123" });
    expect(headers["Authorization"]).toBe("Bearer sk-123");
  });

  it("bearer honors a custom headerTemplate", () => {
    const { headers } = apply(
      { scheme: "bearer", headerTemplate: "token {{apiKey}}" },
      { apiKey: "abc" }
    );
    expect(headers["Authorization"]).toBe("token abc");
  });

  it("api-key-header uses default x-api-key header", () => {
    const { headers } = apply({ scheme: "api-key-header" }, { apiKey: "k1" });
    expect(headers["x-api-key"]).toBe("k1");
  });

  it("api-key-header honors a custom headerName", () => {
    const { headers } = apply(
      { scheme: "api-key-header", headerName: "xc-token" },
      { apiKey: "k2" }
    );
    expect(headers["xc-token"]).toBe("k2");
  });

  it("basic base64-encodes username:password", () => {
    const { headers } = apply({ scheme: "basic" }, { username: "user", password: "pass" });
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`
    );
  });

  it("basic falls back to apiKey as the password when no password field", () => {
    const { headers } = apply({ scheme: "basic" }, { username: "u", apiKey: "secret" });
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("u:secret").toString("base64")}`);
  });

  it("query-param sets the key on the URL", () => {
    const { url } = apply({ scheme: "query-param", queryParam: "key" }, { apiKey: "qp" });
    expect(url.searchParams.get("key")).toBe("qp");
  });

  it("query-param defaults to api_key", () => {
    const { url } = apply({ scheme: "query-param" }, { apiKey: "qp2" });
    expect(url.searchParams.get("api_key")).toBe("qp2");
  });

  it("custom requires both headerName and headerTemplate", () => {
    const { headers } = apply(
      { scheme: "custom", headerName: "X-Auth", headerTemplate: "Key {{apiKey}}" },
      { apiKey: "z" }
    );
    expect(headers["X-Auth"]).toBe("Key z");

    const { headers: none } = apply({ scheme: "custom" }, { apiKey: "z" });
    expect(Object.keys(none)).toHaveLength(0);
  });
});

describe("applyAuth — OAuth accessToken preference", () => {
  it("prefers accessToken over a stale apiKey for bearer", () => {
    const { headers } = apply({ scheme: "bearer" }, { apiKey: "stale", accessToken: "fresh" });
    expect(headers["Authorization"]).toBe("Bearer fresh");
  });

  it("resolvePrimarySecret order is accessToken > apiKey > token", () => {
    expect(resolvePrimarySecret({ accessToken: "a", apiKey: "b", token: "c" })).toBe("a");
    expect(resolvePrimarySecret({ apiKey: "b", token: "c" })).toBe("b");
    expect(resolvePrimarySecret({ token: "c" })).toBe("c");
    expect(resolvePrimarySecret({})).toBe("");
  });
});

describe("applyAuth — header injection defense", () => {
  it("strips CR/LF from injected secret values", () => {
    const { headers } = apply({ scheme: "bearer" }, { apiKey: "abc\r\nX-Evil: 1" });
    expect(headers["Authorization"]).toBe("Bearer abcX-Evil: 1");
    expect(headers["Authorization"]).not.toContain("\n");
  });

  it("strips CR/LF from a custom header name", () => {
    const { headers } = apply(
      { scheme: "api-key-header", headerName: "x-api\r\nkey" },
      { apiKey: "v" }
    );
    expect(Object.keys(headers)[0]).toBe("x-apikey");
  });
});

describe("buildUrl", () => {
  it("substitutes path params and appends query params", () => {
    const out = buildUrl(
      "https://api.example.com/",
      "/repos/{owner}/{repo}",
      { owner: "a", repo: "b" },
      { page: 2, active: true, skip: "" }
    );
    const u = new URL(out);
    expect(u.pathname).toBe("/repos/a/b");
    expect(u.searchParams.get("page")).toBe("2");
    expect(u.searchParams.get("active")).toBe("true");
    // empty-string query values are dropped
    expect(u.searchParams.has("skip")).toBe(false);
  });

  it("url-encodes path params", () => {
    const out = buildUrl("https://x.test", "/q/{term}", { term: "a/b c" }, {});
    expect(out).toContain("/q/a%2Fb%20c");
  });
});

describe("stripCrlf", () => {
  it("collapses CR/LF runs", () => {
    expect(stripCrlf("a\r\n\r\nb")).toBe("ab");
  });
});
