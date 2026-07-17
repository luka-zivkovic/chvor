import { describe, expect, it } from "vitest";
import { HttpError, responseErrorMessage, responseHttpError } from "./http-error";

describe("responseErrorMessage", () => {
  it("preserves a safe server validation detail", () => {
    expect(
      responseErrorMessage(
        { error: "Invalid evaluation case", detail: "input must be valid JSON" },
        "HTTP 400"
      )
    ).toBe("Invalid evaluation case: input must be valid JSON");
  });

  it("uses the headline without a detail", () => {
    expect(responseErrorMessage({ error: "Conflict" }, "HTTP 409")).toBe("Conflict");
  });

  it("preserves a nested legacy error message and bounded code", () => {
    const error = responseHttpError(
      503,
      { error: { code: "CAPABILITY_CATALOG_NOT_READY", message: "Retry shortly." } },
      "HTTP 503"
    );
    expect(error).toMatchObject({
      status: 503,
      code: "CAPABILITY_CATALOG_NOT_READY",
      message: "Retry shortly.",
    });
  });

  it("ignores non-string response fields", () => {
    expect(responseErrorMessage({ error: 400, detail: ["secret"] }, "HTTP 400")).toBe("HTTP 400");
  });

  it("creates an Error subtype with status and validated 409 revision metadata", () => {
    const error = responseHttpError(
      409,
      {
        error: "Conflict",
        expectedRevision: 2,
        actualRevision: 3,
        internal: { secret: true },
      },
      "HTTP 409"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 409,
      expectedRevision: 2,
      actualRevision: 3,
      message: "Conflict",
    });
    expect(error).not.toHaveProperty("body");
    expect(error).not.toHaveProperty("internal");
  });

  it("does not trust conflict metadata from other statuses or invalid revisions", () => {
    const wrongStatus = responseHttpError(
      400,
      { expectedRevision: 2, actualRevision: 3 },
      "HTTP 400"
    );
    const invalidRevision = responseHttpError(
      409,
      { expectedRevision: "2", actualRevision: 3 },
      "HTTP 409"
    );

    expect(wrongStatus).not.toHaveProperty("expectedRevision");
    expect(wrongStatus).not.toHaveProperty("actualRevision");
    expect(invalidRevision).not.toHaveProperty("expectedRevision");
    expect(invalidRevision).not.toHaveProperty("actualRevision");
  });

  it("preserves only bounded setup metadata needed for recovery", () => {
    const error = responseHttpError(
      400,
      {
        error: "Setup required",
        needsSetup: true,
        setupCredentialType: "google-oauth-app",
        code: "SETUP_REQUIRED",
        flowId: "flow-1",
        internal: { accessToken: "must-not-escape" },
      },
      "HTTP 400"
    );

    expect(error).toMatchObject({
      needsSetup: true,
      setupCredentialType: "google-oauth-app",
      code: "SETUP_REQUIRED",
      flowId: "flow-1",
    });
    expect(error).not.toHaveProperty("internal");
    expect(error).not.toHaveProperty("body");
  });

  it("preserves bounded OAuth reauthentication metadata without response internals", () => {
    const error = responseHttpError(
      401,
      {
        error: "Authorization revoked",
        needsReauthentication: true,
        credentialId: "credential-oauth-1",
        oauthCredentialId: "credential-oauth-1",
        connectionId: "oauth-attempt-1",
        failureCode: "oauth_refresh_revoked",
        authStatus: "revoked",
        internal: { refreshToken: "must-not-escape" },
      },
      "HTTP 401"
    );

    expect(error).toMatchObject({
      needsReauthentication: true,
      credentialId: "credential-oauth-1",
      oauthCredentialId: "credential-oauth-1",
      connectionId: "oauth-attempt-1",
      failureCode: "oauth_refresh_revoked",
      authStatus: "revoked",
    });
    expect(error).not.toHaveProperty("internal");
    expect(error).not.toHaveProperty("body");
  });

  it("preserves only bounded OAuth app credential candidates", () => {
    const error = responseHttpError(
      409,
      {
        error: "Select OAuth app credentials",
        code: "oauth_app_credential_selection_required",
        candidateCredentialIds: [
          "github-app-personal",
          "",
          "x".repeat(257),
          "github-app-work",
          { id: "not-a-string" },
        ],
        internal: { clientSecret: "must-not-escape" },
      },
      "HTTP 409"
    );

    expect(error).toMatchObject({
      status: 409,
      code: "oauth_app_credential_selection_required",
      candidateCredentialIds: ["github-app-personal", "github-app-work"],
    });
    expect(error).not.toHaveProperty("internal");
    expect(error).not.toHaveProperty("body");
  });
});
