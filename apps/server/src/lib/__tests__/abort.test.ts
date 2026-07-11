import { describe, expect, it } from "vitest";
import {
  ignoreAfterAbort,
  waitForAbortSettlement,
  waitForAbortSideEffectSettlement,
  withAbort,
  withAbortSideEffectFence,
} from "../orchestrator/abort.ts";

describe("abort fencing", () => {
  it("suppresses late stream callbacks after cancellation", () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const guarded = ignoreAfterAbort((chunk: string) => chunks.push(chunk), controller.signal);

    guarded?.("before");
    controller.abort();
    guarded?.("after");

    expect(chunks).toEqual(["before"]);
  });

  it("rejects promptly but fences release until the underlying operation settles", async () => {
    const controller = new AbortController();
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const raced = withAbort(operation, controller.signal);

    controller.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });

    let fenceReleased = false;
    const fence = waitForAbortSettlement(controller.signal).then(() => {
      fenceReleased = true;
    });
    await Promise.resolve();
    expect(fenceReleased).toBe(false);

    resolveOperation();
    await fence;
    expect(fenceReleased).toBe(true);
  });

  it("holds the side-effect fence until an initiated operation settles", async () => {
    const controller = new AbortController();
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const raced = withAbortSideEffectFence(operation, controller.signal);

    controller.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });

    let released = false;
    const fence = waitForAbortSideEffectSettlement(controller.signal).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    resolveOperation();
    await fence;
    expect(released).toBe(true);
  });
});
