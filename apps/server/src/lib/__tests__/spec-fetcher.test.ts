import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the SSRF gate: pass for public hosts, throw for private ones.
vi.mock("../synthesized-caller.ts", () => ({
  assertSafeSynthesizedUrl: vi.fn(async (rawUrl: string) => {
    const u = new URL(rawUrl);
    const host = u.hostname;
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "169.254.169.254" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      throw new Error(`private hostname blocked: ${host}`);
    }
    return u;
  }),
}));

vi.mock("../../db/synthesized-store.ts", () => ({
  cacheDiscoveredSpec: vi.fn(),
  loadCachedSpec: vi.fn(() => null),
}));

import { discoverOpenApi } from "../spec-fetcher.ts";

type FetchImpl = (input: string) => Response | null;

function installFetch(impl: FetchImpl): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    const res = impl(url);
    if (res) return res;
    return new Response("", { status: 404 });
  });
}

/**
 * Pull the list of URLs actually requested from `fetch`, so tests can assert
 * that dangerous targets were NEVER fetched even when the function falls back
 * to other probe paths (APIs.guru, etc).
 */
function fetchedUrls(spy: ReturnType<typeof installFetch>): string[] {
  return spy.mock.calls.map((call: unknown[]) => {
    const input = call[0];
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return (input as Request).url;
  });
}

describe("spec-fetcher redirect SSRF gating", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a 302 Location pointing at the cloud metadata endpoint", async () => {
    const spy = installFetch((url) => {
      if (url === "https://public.example.com/openapi.json") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return null;
    });

    const result = await discoverOpenApi({
      serviceName: "test-service",
      hintedSpecUrl: "https://public.example.com/openapi.json",
      skipCache: true,
    });

    expect(result).toBeNull();
    // The dangerous Location header was NEVER followed.
    expect(fetchedUrls(spy)).not.toContain("http://169.254.169.254/latest/meta-data/");
  });

  it("rejects a 302 Location pointing at localhost", async () => {
    const spy = installFetch((url) => {
      if (url === "https://public.example.com/openapi.json") {
        return new Response(null, {
          status: 301,
          headers: { location: "http://localhost:9999/openapi.json" },
        });
      }
      return null;
    });

    const result = await discoverOpenApi({
      serviceName: "test-service",
      hintedSpecUrl: "https://public.example.com/openapi.json",
      skipCache: true,
    });

    expect(result).toBeNull();
    expect(fetchedUrls(spy)).not.toContain("http://localhost:9999/openapi.json");
  });

  it("follows a legitimate public → public 301 and loads the final spec", async () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/widgets": { get: { operationId: "listWidgets", summary: "List widgets" } },
      },
    });
    const spy = installFetch((url) => {
      if (url === "https://public.example.com/spec") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://public.example.com/spec/v1.json" },
        });
      }
      if (url === "https://public.example.com/spec/v1.json") {
        return new Response(spec, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return null;
    });

    const result = await discoverOpenApi({
      serviceName: "test-service",
      hintedSpecUrl: "https://public.example.com/spec",
      skipCache: true,
    });

    expect(result).not.toBeNull();
    expect(result!.specUrl).toBe("https://public.example.com/spec");
    expect(result!.operations).toHaveLength(1);
    expect(result!.operations[0].name).toBe("listwidgets");
    // Hinted URL + one redirect hop — success short-circuits the fallback probes.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_REDIRECTS hops even when every hop is public", async () => {
    // Only the hinted URL chain should redirect. APIs.guru fallback returns 404
    // so the count represents just the hinted-URL hop cap.
    const spy = installFetch((url) => {
      if (url.startsWith("https://public.example.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://public.example.com/next" },
        });
      }
      return null;
    });

    const result = await discoverOpenApi({
      serviceName: "test-service",
      hintedSpecUrl: "https://public.example.com/start",
      skipCache: true,
    });

    expect(result).toBeNull();
    // Hinted URL chain: initial fetch + 3 redirect hops = 4; then APIs.guru
    // lookup is attempted (once, 404) = 5 total. The chain-length cap itself
    // is asserted by counting only public.example.com calls.
    const publicHops = fetchedUrls(spy).filter((u) => u.startsWith("https://public.example.com/"));
    expect(publicHops).toHaveLength(4);
  });
});
