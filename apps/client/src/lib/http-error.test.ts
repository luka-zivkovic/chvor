import { describe, expect, it } from "vitest";
import { responseErrorMessage } from "./http-error";

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
});
