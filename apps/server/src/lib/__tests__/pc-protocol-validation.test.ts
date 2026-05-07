import { describe, expect, it } from "vitest";
import {
  MAX_REMOTE_SHELL_OUTPUT_CHARS,
  parseRemoteActionResult,
  parseRemoteShellResult,
} from "../pc-protocol-validation.ts";

const INVALID_SHELL_RESULT = {
  stdout: "",
  stderr: "Invalid shell response from agent",
  exitCode: 1,
};

describe("pc protocol validation", () => {
  it("accepts valid remote action results", () => {
    expect(parseRemoteActionResult({ success: true })).toEqual({ success: true });
    expect(parseRemoteActionResult({ success: false, error: "denied" })).toEqual({
      success: false,
      error: "denied",
    });
  });

  it("fails closed for malformed remote action results", () => {
    for (const value of [null, undefined, "ok", { success: "false" }, { error: "oops" }]) {
      expect(parseRemoteActionResult(value)).toEqual({
        success: false,
        error: "Invalid action response from agent",
      });
    }
  });

  it("accepts valid remote shell results", () => {
    expect(parseRemoteShellResult({ stdout: "out", stderr: "err", exitCode: 2 })).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 2,
    });
  });

  it("fails closed for malformed remote shell result shapes", () => {
    for (const value of [
      null,
      undefined,
      "ok",
      { stdout: "out", stderr: "err" },
      { stdout: 1, stderr: "err", exitCode: 0 },
      { stdout: "out", stderr: false, exitCode: 0 },
    ]) {
      expect(parseRemoteShellResult(value)).toEqual(INVALID_SHELL_RESULT);
    }
  });

  it("fails closed for invalid remote shell exit codes", () => {
    for (const exitCode of ["0", 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseRemoteShellResult({ stdout: "", stderr: "", exitCode })).toEqual(
        INVALID_SHELL_RESULT
      );
    }
  });

  it("fails closed for oversized remote shell stdout or stderr", () => {
    const oversized = "x".repeat(MAX_REMOTE_SHELL_OUTPUT_CHARS + 1);

    expect(parseRemoteShellResult({ stdout: oversized, stderr: "", exitCode: 0 })).toEqual(
      INVALID_SHELL_RESULT
    );
    expect(parseRemoteShellResult({ stdout: "", stderr: oversized, exitCode: 0 })).toEqual(
      INVALID_SHELL_RESULT
    );
  });
});
