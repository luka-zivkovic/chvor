import type { IntegrationSetupFlowSnapshot } from "@chvor/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  credentials: vi.fn(),
  acknowledge: vi.fn(),
  confirm: vi.fn(),
  discovery: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../../lib/integration-setup-service.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/integration-setup-service.ts")>();
  return {
    ...original,
    startIntegrationSetup: serviceMocks.start,
    getIntegrationSetup: serviceMocks.get,
    listIntegrationSetups: serviceMocks.list,
    submitIntegrationSetupCredentials: serviceMocks.credentials,
    acknowledgeIntegrationSetupInstruction: serviceMocks.acknowledge,
    confirmIntegrationSetupDuplicate: serviceMocks.confirm,
    submitIntegrationSetupDiscovery: serviceMocks.discovery,
    cancelIntegrationSetup: serviceMocks.cancel,
  };
});

import {
  IntegrationSetupCredentialChangedError,
  IntegrationSetupCredentialNotFoundError,
  IntegrationSetupManifestNotFoundError,
  IntegrationSetupRequestError,
} from "../../lib/integration-setup-service.ts";
import {
  IntegrationSetupFlowNotFoundError,
  IntegrationSetupRevisionConflictError,
} from "../../db/integration-setup-store.ts";
import routes from "../integration-setup.ts";

const flow: IntegrationSetupFlowSnapshot = {
  schemaVersion: 1,
  id: "flow-1",
  integrationId: "provider.github",
  manifestVersion: "1.2.3",
  manifestCredentialId: "credential.github",
  currentStepId: "setup.credentials",
  credentialType: "github",
  mode: "setup",
  status: "awaiting-input",
  authStatus: "unknown",
  oauthCreateAdditional: false,
  steps: [
    {
      id: "setup.credentials",
      kind: "credential",
      status: "active",
      attempts: 1,
      startedAt: "2026-07-13T10:00:00.000Z",
    },
  ],
  duplicateCandidates: [],
  revision: 3,
  createdAt: "2026-07-13T09:59:59.000Z",
  updatedAt: "2026-07-13T10:00:00.000Z",
  expiresAt: "2026-07-13T10:30:00.000Z",
};

function startBody() {
  return {
    schemaVersion: 1,
    integrationId: "provider.github",
    manifestVersion: "1.2.3",
    manifestCredentialId: "credential.github",
    credentialType: "github",
    mode: "setup",
  };
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; rawBody?: string } = {}
): Promise<Response> {
  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return routes.fetch(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      ...(body === undefined ? {} : { body, headers: { "Content-Type": "application/json" } }),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.start.mockReturnValue(flow);
  serviceMocks.get.mockReturnValue(flow);
  serviceMocks.list.mockReturnValue([flow]);
  serviceMocks.credentials.mockReturnValue(flow);
  serviceMocks.acknowledge.mockReturnValue(flow);
  serviceMocks.confirm.mockReturnValue(flow);
  serviceMocks.discovery.mockReturnValue(flow);
  serviceMocks.cancel.mockReturnValue({ ...flow, status: "cancelled", currentStepId: undefined });
});

describe("integration setup API envelopes", () => {
  it("starts, lists, and retrieves flows in data envelopes", async () => {
    const started = await request("/", { method: "POST", body: startBody() });
    expect(started.status).toBe(201);
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(await started.json()).toEqual({ data: flow });
    expect(serviceMocks.start).toHaveBeenCalledWith(startBody());

    const listed = await request("/");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ data: [flow] });

    const fetched = await request("/flow-1");
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ data: flow });
    expect(serviceMocks.get).toHaveBeenCalledWith("flow-1");
  });

  it("adapts credential, acknowledgement, confirmation, discovery, and cancellation requests", async () => {
    const credentials = {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 3,
      stepId: "setup.credentials",
      data: { token: "request-only-secret" },
    };
    const credentialResponse = await request("/flow-1/credentials", {
      method: "POST",
      body: credentials,
    });
    const credentialEnvelope = await credentialResponse.json();
    expect(credentialEnvelope).toEqual({ data: flow });
    expect(JSON.stringify(credentialEnvelope)).not.toContain("request-only-secret");
    expect(serviceMocks.credentials).toHaveBeenCalledWith("flow-1", credentials);

    const acknowledgement = {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 3,
      stepId: "setup.instructions",
    };
    const acknowledgementResponse = await request("/flow-1/acknowledge", {
      method: "POST",
      body: acknowledgement,
    });
    expect(await acknowledgementResponse.json()).toEqual({ data: flow });
    expect(serviceMocks.acknowledge).toHaveBeenCalledWith("flow-1", acknowledgement);

    const confirmation = {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 3,
      decision: "create-additional",
    };
    const confirmationResponse = await request("/flow-1/confirm", {
      method: "POST",
      body: confirmation,
    });
    expect(await confirmationResponse.json()).toEqual({ data: flow });
    expect(serviceMocks.confirm).toHaveBeenCalledWith("flow-1", confirmation);

    const discovery = {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 3,
      stepId: "setup.discovery",
    };
    const discoveryResponse = await request("/flow-1/discovery", {
      method: "POST",
      body: discovery,
    });
    expect(await discoveryResponse.json()).toEqual({ data: flow });
    expect(serviceMocks.discovery).toHaveBeenCalledWith("flow-1", discovery);

    const cancellation = { schemaVersion: 1, flowId: "flow-1", revision: 3 };
    const cancelResponse = await request("/flow-1/cancel", {
      method: "POST",
      body: cancellation,
    });
    expect((await cancelResponse.json()) as { data: { status: string } }).toMatchObject({
      data: { status: "cancelled" },
    });
    expect(serviceMocks.cancel).toHaveBeenCalledWith("flow-1", cancellation);
  });

  it("rejects forged OAuth/auth state at the strict discovery boundary", async () => {
    const forged = {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 3,
      authStatus: "active",
      duplicateCandidates: [],
    };
    const response = await request("/flow-1/discovery", {
      method: "POST",
      body: forged,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_integration_setup_request" });
    expect(serviceMocks.discovery).not.toHaveBeenCalled();
  });
});

describe("integration setup API validation and safe errors", () => {
  it("strictly rejects malformed JSON, unknown fields, and unsafe failure codes", async () => {
    const malformed = await request("/", { method: "POST", rawBody: "{" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Invalid integration setup request",
      code: "invalid_integration_setup_request",
    });

    const unknown = await request("/", {
      method: "POST",
      body: { ...startBody(), accessToken: "must-not-pass" },
    });
    expect(unknown.status).toBe(400);
    expect(serviceMocks.start).not.toHaveBeenCalled();

    const unsafeFailure = await request("/flow-1/discovery", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        authStatus: "failed",
        duplicateCandidates: [],
        failureCode: "Bearer request-only-secret",
      },
    });
    expect(unsafeFailure.status).toBe(400);
    expect(serviceMocks.discovery).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing manifest, flow, or credential", async () => {
    serviceMocks.start.mockImplementation(() => {
      throw new IntegrationSetupManifestNotFoundError("missing");
    });
    const missingManifest = await request("/", { method: "POST", body: startBody() });
    expect(missingManifest.status).toBe(404);
    expect(await missingManifest.json()).toEqual({
      error: "Integration manifest not found",
      code: "integration_manifest_not_found",
    });

    serviceMocks.get.mockImplementation(() => {
      throw new IntegrationSetupFlowNotFoundError("missing");
    });
    const missingFlow = await request("/missing");
    expect(missingFlow.status).toBe(404);
    expect(await missingFlow.json()).toMatchObject({ code: "integration_setup_flow_not_found" });

    serviceMocks.credentials.mockImplementation(() => {
      throw new IntegrationSetupCredentialNotFoundError("missing");
    });
    const missingCredential = await request("/flow-1/credentials", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        stepId: "setup.credentials",
        data: { token: "secret" },
      },
    });
    expect(missingCredential.status).toBe(404);
    expect(await missingCredential.json()).toMatchObject({
      code: "integration_credential_not_found",
    });
  });

  it("returns exact optimistic conflict metadata and generic request failures", async () => {
    serviceMocks.confirm.mockImplementation(() => {
      throw new IntegrationSetupRevisionConflictError(3, 5);
    });
    const conflict = await request("/flow-1/confirm", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        decision: "create-additional",
      },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "Integration setup revision conflict",
      code: "integration_setup_revision_conflict",
      expectedRevision: 3,
      actualRevision: 5,
    });

    serviceMocks.cancel.mockImplementation(() => {
      throw new IntegrationSetupRequestError("flow mismatch");
    });
    const invalid = await request("/flow-1/cancel", {
      method: "POST",
      body: { schemaVersion: 1, flowId: "flow-2", revision: 3 },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Invalid integration setup request",
      code: "invalid_integration_setup_request",
    });

    serviceMocks.credentials.mockImplementation(() => {
      throw new IntegrationSetupCredentialChangedError("credential changed");
    });
    const changed = await request("/flow-1/credentials", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        stepId: "setup.credentials",
        data: { token: "new-secret" },
      },
    });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toEqual({
      error: "Invalid integration setup request",
      code: "integration_credential_changed",
    });
  });

  it("strictly validates the local cancellation request schema", async () => {
    const invalid = await request("/flow-1/cancel", {
      method: "POST",
      body: { schemaVersion: 1, flowId: "flow-1", revision: 3, token: "secret" },
    });
    expect(invalid.status).toBe(400);
    expect(serviceMocks.cancel).not.toHaveBeenCalled();
  });

  it("strictly validates acknowledgement bodies and URL/body identity", async () => {
    const unknown = await request("/flow-1/acknowledge", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        stepId: "setup.instructions",
        acknowledged: true,
      },
    });
    expect(unknown.status).toBe(400);
    expect(serviceMocks.acknowledge).not.toHaveBeenCalled();

    const valid = {
      schemaVersion: 1,
      flowId: "flow-2",
      revision: 3,
      stepId: "setup.instructions",
    };
    serviceMocks.acknowledge.mockImplementationOnce(() => {
      throw new IntegrationSetupRequestError("flow mismatch");
    });
    const response = await request("/flow-1/acknowledge", { method: "POST", body: valid });
    expect(response.status).toBe(400);
    expect(serviceMocks.acknowledge).toHaveBeenCalledWith("flow-1", valid);
  });

  it("validates URL IDs before parsing bodies and enforces duplicate-choice shapes", async () => {
    const badUrl = await request("/bad%20flow/credentials", {
      method: "POST",
      rawBody: "{not-json",
    });
    expect(badUrl.status).toBe(400);
    expect(serviceMocks.credentials).not.toHaveBeenCalled();

    const missingCandidate = await request("/flow-1/confirm", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        decision: "reuse-existing",
      },
    });
    expect(missingCandidate.status).toBe(400);

    const extraCandidate = await request("/flow-1/confirm", {
      method: "POST",
      body: {
        schemaVersion: 1,
        flowId: "flow-1",
        revision: 3,
        decision: "cancel",
        credentialId: "credential-1",
      },
    });
    expect(extraCandidate.status).toBe(400);

    const replace = {
      schemaVersion: 1,
      flowId: "flow-1",
      revision: 3,
      decision: "replace-existing",
      credentialId: "credential-1",
    };
    const validReplace = await request("/flow-1/confirm", {
      method: "POST",
      body: replace,
    });
    expect(validReplace.status).toBe(200);
    expect(serviceMocks.confirm).toHaveBeenCalledWith("flow-1", replace);
  });
});
