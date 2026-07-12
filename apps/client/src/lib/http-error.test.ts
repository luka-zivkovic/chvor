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
});
