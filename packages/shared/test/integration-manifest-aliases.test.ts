import { describe, expect, it } from "vitest";
import {
  currentIntegrationCredentialFieldSchema,
  integrationCredentialFieldSchema,
} from "../src/index.js";

const legacyField = {
  id: "client.id",
  label: "Client ID",
  description: "OAuth client identifier.",
  sensitivity: "text",
  required: true,
} as const;

describe("integration manifest component aliases", () => {
  it("keeps the unversioned credential field alias on V1", () => {
    expect(integrationCredentialFieldSchema.safeParse(legacyField).success).toBe(true);
    expect(
      integrationCredentialFieldSchema.safeParse({ ...legacyField, storageKey: "clientId" }).success
    ).toBe(false);
    expect(
      currentIntegrationCredentialFieldSchema.safeParse({
        ...legacyField,
        storageKey: "clientId",
      }).success
    ).toBe(true);
  });
});
