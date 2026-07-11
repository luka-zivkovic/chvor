import { describe, expect, it } from "vitest";
import { settleTimedOutDaemonExecution, shouldRetryDaemonFailure } from "../daemon-timeout.ts";
import { withAbort } from "../orchestrator/abort.ts";

describe("daemon timeout fencing", () => {
  it("holds release until detached work settles and forbids timeout retries", async () => {
    const controller = new AbortController();
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    const execution = withAbort(work, controller.signal);
    controller.abort();

    let released = false;
    const settlement = settleTimedOutDaemonExecution(execution, controller.signal).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(shouldRetryDaemonFailure(true, 0, 2)).toBe(false);
    expect(shouldRetryDaemonFailure(false, 0, 2)).toBe(true);

    resolveWork();
    await settlement;
    expect(released).toBe(true);
  });

  it("releases after the settlement deadline without permitting a retry", async () => {
    const controller = new AbortController();
    const execution = new Promise<void>(() => undefined);
    controller.abort();

    await expect(settleTimedOutDaemonExecution(execution, controller.signal, 10)).resolves.toBe(
      false
    );
    expect(shouldRetryDaemonFailure(true, 0, 2)).toBe(false);
  });
});
