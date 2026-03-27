import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { filterEnv, pollHealth } from "./process.js";

describe("filterEnv", () => {
  it("removes entries with undefined values", () => {
    const input = { A: "1", B: undefined, C: "3" } as NodeJS.ProcessEnv;
    const result = filterEnv(input);
    expect(result).toEqual({ A: "1", C: "3" });
  });

  it("returns empty object for empty input", () => {
    expect(filterEnv({})).toEqual({});
  });

  it("keeps all entries when none are undefined", () => {
    const input = { X: "x", Y: "y" } as NodeJS.ProcessEnv;
    expect(filterEnv(input)).toEqual({ X: "x", Y: "y" });
  });
});

describe("pollHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns true when server responds with ok: true", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await pollHealth("3001");
    expect(result).toBe(true);
  });

  it("sends Authorization header when token is provided", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await pollHealth("3001", "my-secret-token");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/health",
      { headers: { Authorization: "Bearer my-secret-token" } }
    );
  });

  it("retries on fetch failure and succeeds eventually", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const result = await pollHealth("3001", undefined, 30000, 100);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("returns false when timeout expires", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await pollHealth("3001", undefined, 1000, 200);
    expect(result).toBe(false);
  });

  it("retries when response is not ok", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const result = await pollHealth("3001", undefined, 30000, 100);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries when body.ok is not true", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const result = await pollHealth("3001", undefined, 30000, 100);
    expect(result).toBe(true);
  });
});
