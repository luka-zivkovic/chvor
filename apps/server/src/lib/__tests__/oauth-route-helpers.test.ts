import { beforeEach, describe, expect, it, vi } from "vitest";

const credentialStore = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
}));
const authGate = vi.hoisted(() => ({
  assertUsable: vi.fn(),
  getBlock: vi.fn(),
}));

vi.mock("../../db/credential-store.ts", () => ({
  getCredentialData: credentialStore.get,
  listCredentialMetadata: credentialStore.list,
}));
vi.mock("../../db/integration-setup-store.ts", () => ({
  getIntegrationSetupFlow: vi.fn(() => null),
}));
vi.mock("../credential-auth-usability.ts", () => ({
  assertCredentialAuthUsable: authGate.assertUsable,
  getPersistedCredentialAuthBlock: authGate.getBlock,
}));

import { directAppCredentials, selectDirectOAuthCredentials } from "../oauth-route-helpers.ts";
import { OAUTH_PROVIDERS } from "../provider-registry.ts";

function googleProvider() {
  const provider = OAUTH_PROVIDERS.find((item) => item.id === "google");
  if (!provider) throw new Error("Google provider fixture is missing");
  return provider;
}

describe("OAuth app credential auth gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credentialStore.list.mockReturnValue([
      { id: "app-active", type: "google-oauth" },
      { id: "app-blocked", type: "google-oauth" },
    ]);
    authGate.getBlock.mockImplementation((id: string) =>
      id === "app-active" ? null : { credentialId: id, authStatus: "revoked" }
    );
  });

  it("does not advertise blocked app credentials as direct OAuth candidates", () => {
    expect(directAppCredentials(googleProvider()).map((item) => item.id)).toEqual(["app-active"]);
  });

  it("rechecks the selected app credential immediately before decrypting it", () => {
    authGate.getBlock.mockReturnValue(null);
    authGate.assertUsable.mockImplementation(() => {
      throw new Error("reauthentication required");
    });

    expect(() =>
      selectDirectOAuthCredentials(googleProvider(), {
        provider: "google",
        appCredentialId: "app-active",
      })
    ).toThrow("reauthentication required");
    expect(credentialStore.get).not.toHaveBeenCalled();
  });
});
