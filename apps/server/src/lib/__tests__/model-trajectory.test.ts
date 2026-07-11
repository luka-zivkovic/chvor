import { describe, expect, it } from "vitest";
import {
  readTrackedModelMetadata,
  runTrackedModelSetup,
} from "../orchestrator/model-trajectory.ts";

describe("model trajectory helpers", () => {
  it("returns settled metadata", async () => {
    await expect(
      readTrackedModelMetadata(Promise.resolve({ promptTokens: 2 }), Promise.resolve("stop"))
    ).resolves.toEqual([{ promptTokens: 2 }, "stop"]);
  });

  it("does not wait forever for provider metadata", async () => {
    const startedAt = Date.now();
    const never = new Promise<never>(() => undefined);
    await expect(readTrackedModelMetadata(never, never)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("preserves synchronous setup failures instead of applying fallback behavior", () => {
    const original = new Error("setup failed");
    expect(() =>
      runTrackedModelSetup({
        requestStepId: null,
        config: { providerId: "openai", model: "test", apiKey: "test" },
        wasFallback: false,
        operation: () => {
          throw original;
        },
      })
    ).toThrow(original);
  });
});
