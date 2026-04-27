import { describe, it, expect } from "vitest";
import {
  ChvorError,
  CredentialError,
  SynthesizedToolError,
  LLMError,
  serializeError,
  httpStatusFor,
  isChvorError,
  wrapError,
} from "../errors.ts";

describe("ChvorError", () => {
  it("attaches code, category, and default httpStatus", () => {
    const err = new CredentialError("missing key", { code: "credential.missing" });
    expect(err.code).toBe("credential.missing");
    expect(err.category).toBe("capability_error");
    // Default mapped from DEFAULT_HTTP_STATUS table
    expect(err.httpStatus).toBe(401);
    expect(isChvorError(err)).toBe(true);
  });

  it("preserves cause through Error chain", () => {
    const root = new Error("upstream failed");
    const wrapped = new SynthesizedToolError("call failed", {
      code: "synth.upstream_error",
      cause: root,
    });
    expect(wrapped.cause).toBe(root);
  });

  it("instanceof works after wrapError + serializeError round-trip", () => {
    const raw = new Error("boom");
    const wrapped = wrapError(raw, { code: "internal.unexpected" });
    expect(wrapped).toBeInstanceOf(ChvorError);
    expect(wrapped.cause).toBe(raw);
    // wrapError returns the same instance if already a ChvorError
    expect(wrapError(wrapped, { code: "internal.unexpected" })).toBe(wrapped);
  });
});

describe("serializeError", () => {
  it("redacts sensitive data in message + cause", () => {
    const err = new LLMError("Bearer sk-abcdefghijklmnopqrstuvwxyz failed", {
      code: "llm.upstream_error",
      cause: new Error('api_key="sk-zzzzzzzzzzzzzzzzzzzzzzzz"'),
    });
    const out = serializeError(err);
    expect(out.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(out.cause?.message).not.toContain("sk-zzzzzzzzzzzzzzzzzzzzzzzz");
  });

  it("redacts sensitive context values", () => {
    const err = new SynthesizedToolError("forbidden", {
      code: "synth.upstream_error",
      context: {
        endpoint: "/v1/users",
        token: "Bearer sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        statusCode: 401,
      },
    });
    const out = serializeError(err);
    expect(out.context?.endpoint).toBe("/v1/users");
    expect(out.context?.statusCode).toBe(401);
    expect(JSON.stringify(out.context?.token)).not.toContain("sk-aaaa");
  });

  it("collapses non-Chvor errors to internal.unexpected", () => {
    const out = serializeError(new TypeError("oops"));
    expect(out.code).toBe("internal.unexpected");
    expect(out.category).toBe("system_error");
    expect(out.message).toBe("oops");
  });

  it("never includes stack trace unless DEBUG_ERRORS=1", () => {
    const out = serializeError(new ChvorError("boom", { code: "internal.unexpected" }));
    expect(out.stack).toBeUndefined();
  });
});

describe("httpStatusFor", () => {
  it("returns 401 for credential.missing", () => {
    expect(httpStatusFor(new CredentialError("x", { code: "credential.missing" }))).toBe(401);
  });
  it("returns 429 for rate_limit.exceeded", () => {
    expect(
      httpStatusFor(new ChvorError("x", { code: "rate_limit.exceeded" })),
    ).toBe(429);
  });
  it("returns 500 for non-Chvor errors", () => {
    expect(httpStatusFor(new Error("plain"))).toBe(500);
  });
  it("respects explicit httpStatus override", () => {
    const err = new SynthesizedToolError("x", {
      code: "synth.upstream_error",
      httpStatus: 418,
    });
    expect(err.httpStatus).toBe(418);
  });
});
