import { describe, expect, it } from "vitest";
import { containsSensitiveData, redactSensitiveData } from "../sensitive-filter.ts";

describe("sensitive-filter", () => {
  it("detects and redacts credential-like assignments and prose", () => {
    const samples: Array<{ text: string; leakedValue: string }> = [
      { text: "token=abc123", leakedValue: "abc123" },
      { text: "secret: hunter2", leakedValue: "hunter2" },
      { text: "authorization=Bearer abc123", leakedValue: "abc123" },
      { text: "passcode is 123456", leakedValue: "123456" },
      { text: "api key as supersecret", leakedValue: "supersecret" },
    ];

    for (const { text, leakedValue } of samples) {
      expect(containsSensitiveData(text)).toBe(true);
      const redacted = redactSensitiveData(text);
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain(leakedValue);
    }
  });
});
