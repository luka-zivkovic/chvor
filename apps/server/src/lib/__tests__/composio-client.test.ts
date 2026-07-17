import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectedAccountsList: vi.fn(),
  listCredentialMetadata: vi.fn(),
  getCredentialData: vi.fn(),
  assertUsable: vi.fn(),
}));

vi.mock("@composio/core", () => ({
  Composio: class {
    connectedAccounts = { list: mocks.connectedAccountsList };
  },
}));

vi.mock("../../db/credential-store.ts", () => ({
  listCredentialMetadata: mocks.listCredentialMetadata,
  getCredentialData: mocks.getCredentialData,
}));
vi.mock("../credential-auth-usability.ts", () => ({
  assertCredentialAuthUsable: mocks.assertUsable,
}));

import { verifyConnectedAccount } from "../composio-client.ts";

function remoteAccount(
  overrides: Partial<{
    id: string;
    status: string;
    toolkit: { slug: string };
    isDisabled: boolean;
  }> = {}
) {
  return {
    id: "account_exact",
    status: "ACTIVE",
    toolkit: { slug: "twitter" },
    isDisabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertUsable.mockReset();
  mocks.listCredentialMetadata.mockReturnValue([{ id: "composio-key", type: "composio" }]);
  mocks.getCredentialData.mockReturnValue({ data: { apiKey: "secret" } });
});

describe("verifyConnectedAccount", () => {
  it("enforces the persisted auth gate before decrypting the Composio key", async () => {
    mocks.assertUsable.mockImplementation(() => {
      throw new Error("reauthentication required");
    });

    await expect(verifyConnectedAccount("account_exact", "twitter")).rejects.toThrow(
      "reauthentication required"
    );
    expect(mocks.getCredentialData).not.toHaveBeenCalled();
    expect(mocks.connectedAccountsList).not.toHaveBeenCalled();
  });

  it("requires the exact ACTIVE account for Chvor's fixed entity and expected toolkit", async () => {
    mocks.connectedAccountsList.mockResolvedValue({
      items: [remoteAccount()],
      nextCursor: null,
      totalPages: 1,
    });

    await expect(verifyConnectedAccount("account_exact", "twitter")).resolves.toBe(true);
    expect(mocks.connectedAccountsList).toHaveBeenCalledWith({
      userIds: ["default"],
      toolkitSlugs: ["twitter"],
      statuses: ["ACTIVE"],
      limit: 100,
    });
  });

  it.each([
    ["different account", remoteAccount({ id: "account_other" })],
    ["inactive account", remoteAccount({ status: "INACTIVE" })],
    ["provider mismatch", remoteAccount({ toolkit: { slug: "linkedin" } })],
    ["disabled account", remoteAccount({ isDisabled: true })],
  ])("rejects %s even if returned by the filtered API", async (_case, account) => {
    mocks.connectedAccountsList.mockResolvedValue({
      items: [account],
      nextCursor: null,
      totalPages: 1,
    });

    await expect(verifyConnectedAccount("account_exact", "twitter")).resolves.toBe(false);
  });

  it("follows remote pagination while retaining the fixed filters", async () => {
    mocks.connectedAccountsList
      .mockResolvedValueOnce({ items: [], nextCursor: "page-2", totalPages: 2 })
      .mockResolvedValueOnce({
        items: [remoteAccount()],
        nextCursor: null,
        totalPages: 2,
      });

    await expect(verifyConnectedAccount("account_exact", "twitter")).resolves.toBe(true);
    expect(mocks.connectedAccountsList).toHaveBeenNthCalledWith(2, {
      userIds: ["default"],
      toolkitSlugs: ["twitter"],
      statuses: ["ACTIVE"],
      limit: 100,
      cursor: "page-2",
    });
  });
});
