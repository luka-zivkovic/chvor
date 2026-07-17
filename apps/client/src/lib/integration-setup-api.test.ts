import type { IntegrationSetupFlowSnapshot } from "@chvor/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const flow: IntegrationSetupFlowSnapshot = {
  schemaVersion: 1,
  id: "flow-1",
  integrationId: "integration.github",
  manifestVersion: "1.0.0",
  manifestCredentialId: "credential.github",
  currentStepId: "setup.credential.github",
  credentialType: "github",
  mode: "setup",
  status: "awaiting-input",
  authStatus: "unknown",
  oauthCreateAdditional: false,
  steps: [
    {
      id: "setup.credential.github",
      kind: "credential",
      status: "active",
      attempts: 1,
      startedAt: "2026-07-13T10:00:00.000Z",
    },
  ],
  duplicateCandidates: [],
  revision: 2,
  createdAt: "2026-07-13T10:00:00.000Z",
  updatedAt: "2026-07-13T10:00:00.000Z",
  expiresAt: "2026-07-14T10:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("integration setup API", () => {
  it("sends strict typed mutation bodies and unwraps flow envelopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: flow }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    const body = {
      schemaVersion: 1 as const,
      integrationId: "integration.github",
      manifestVersion: "1.0.0",
      manifestCredentialId: "credential.github",
      credentialType: "github",
      mode: "setup" as const,
    };

    await expect(api.integrationSetup.start(body)).resolves.toEqual(flow);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-setup",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) })
    );
  });

  it("encodes flow IDs for resume and cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: flow }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);

    await api.integrationSetup.get("flow/with space?");
    await api.integrationSetup.cancel("flow/with space?", 4);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/integration-setup/flow%2Fwith%20space%3F");
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/integration-setup/flow%2Fwith%20space%3F/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, flowId: "flow/with space?", revision: 4 }),
      }),
    ]);
  });

  it("submits an explicit instruction acknowledgement with flow revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: flow }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      schemaVersion: 1 as const,
      flowId: "flow-1",
      revision: 2,
      stepId: "setup.instructions",
    };

    await api.integrationSetup.acknowledgeInstruction("flow-1", body);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-setup/flow-1/acknowledge",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) })
    );
  });

  it("requests server-derived discovery without asserting client auth state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ data: flow }),
    } satisfies Partial<Response>);
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      schemaVersion: 1 as const,
      flowId: "flow-1",
      revision: 2,
      stepId: "setup.diagnostic",
    };

    await api.integrationSetup.discovery("flow-1", body);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-setup/flow-1/discovery",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) })
    );
  });
});
