import { waitForAbortSettlement } from "./orchestrator/abort.ts";

export function shouldRetryDaemonFailure(timedOut: boolean, retryCount: number, maxRetries: number): boolean {
  return !timedOut && retryCount < maxRetries;
}

/** Fence daemon release until both the engine wrapper and detached operations settle. */
export async function settleTimedOutDaemonExecution(
  execution: Promise<unknown>,
  signal: AbortSignal,
  settlementTimeoutMs = 30_000
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([execution, waitForAbortSettlement(signal)]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), settlementTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
