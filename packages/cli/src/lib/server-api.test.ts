import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  readConfig: () => ({ port: "9147", token: "local-token", onboarded: true }),
}));

const { createServerApi } = await import("./server-api.js");

function fetchRecorder() {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          report: {
            id: "run",
            passed: true,
            status: "completed",
            summary: {
              total: 1,
              passed: 1,
              failed: 0,
              criticalFailed: 0,
              totalCostUsd: null,
              totalLatencyMs: 1,
            },
            cases: [],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  return fetch;
}

beforeEach(() => {
  delete process.env.CHVOR_URL;
  delete process.env.CHVOR_TOKEN;
});

describe("evaluation server API authentication", () => {
  it("uses the saved token only for the configured default local API", async () => {
    const fetch = fetchRecorder();
    await createServerApi({ fetch }).runEvaluation({});
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer local-token",
    });
  });

  it("never forwards the saved local token to an overridden endpoint", async () => {
    const fetch = fetchRecorder();
    await createServerApi({ baseUrl: "https://example.test/api", fetch }).runEvaluation({});
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });

  it("uses an explicit token for an overridden endpoint", async () => {
    const fetch = fetchRecorder();
    await createServerApi({
      baseUrl: "https://example.test/api",
      token: "remote-token",
      fetch,
    }).runEvaluation({});
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer remote-token",
    });
  });
});
