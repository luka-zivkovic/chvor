export function createAbortError(message = "Execution aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

/** Prevent late callbacks from reviving output after a run has been cancelled. */
export function ignoreAfterAbort<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => void) | undefined,
  signal?: AbortSignal
): ((...args: TArgs) => void) | undefined {
  if (!callback) return undefined;
  return (...args: TArgs): void => {
    if (!signal?.aborted) callback(...args);
  };
}

const pendingSettlements = new WeakMap<AbortSignal, Set<Promise<unknown>>>();
const pendingSideEffectSettlements = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

function trackSettlement(operation: Promise<unknown>, signal?: AbortSignal): void {
  if (!signal) return;
  let pending = pendingSettlements.get(signal);
  if (!pending) {
    pending = new Set();
    pendingSettlements.set(signal, pending);
  }
  pending.add(operation);
  const remove = (): void => {
    pending?.delete(operation);
    if (pending?.size === 0) pendingSettlements.delete(signal);
  };
  operation.then(remove, remove);
}

function trackSideEffectSettlement(operation: Promise<unknown>, signal?: AbortSignal): void {
  if (!signal) return;
  let pending = pendingSideEffectSettlements.get(signal);
  if (!pending) {
    pending = new Set();
    pendingSideEffectSettlements.set(signal, pending);
  }
  pending.add(operation);
  const remove = (): void => {
    pending?.delete(operation);
    if (pending?.size === 0) pendingSideEffectSettlements.delete(signal);
  };
  operation.then(remove, remove);
}

/** Wait until every operation fenced by this signal has actually settled. */
export async function waitForAbortSettlement(signal: AbortSignal): Promise<void> {
  while (true) {
    const pending = pendingSettlements.get(signal);
    if (!pending?.size) return;
    await Promise.allSettled(Array.from(pending));
  }
}

/** Do not terminalize an aborted run while an initiated external side effect is unresolved. */
export async function waitForAbortSideEffectSettlement(signal: AbortSignal): Promise<void> {
  while (true) {
    const pending = pendingSideEffectSettlements.get(signal);
    if (!pending?.size) return;
    await Promise.allSettled(Array.from(pending));
  }
}

/** Reject promptly on cancellation even when an underlying integration lacks signal support. */
export function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  preserveSettledOperation = false
): Promise<T> {
  trackSettlement(operation, signal);
  if (!signal) return operation;
  if (signal.aborted) {
    if (preserveSettledOperation) {
      return Promise.race([operation, Promise.reject(createAbortError())]);
    }
    void operation.catch(() => undefined);
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** Race cancellation while separately fencing the underlying side-effect settlement. */
export function withAbortSideEffectFence<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  trackSideEffectSettlement(operation, signal);
  return withAbort(operation, signal);
}
