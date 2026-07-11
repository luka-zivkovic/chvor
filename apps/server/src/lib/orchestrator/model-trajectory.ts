import type { ResolvedConfig } from "../llm-router.ts";
import { recordTrajectoryModelFailed } from "./trajectory-adapter.ts";

const MODEL_METADATA_TIMEOUT_MS = 250;

/** Read optional provider telemetry without allowing it to block completion. */
export async function readTrackedModelMetadata<T, U>(
  first: PromiseLike<T>,
  second: PromiseLike<U>
): Promise<[T, U] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([first, second]) as Promise<[T, U]>,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), MODEL_METADATA_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Capture synchronous model setup failures without changing fallback semantics. */
export function runTrackedModelSetup<T>(args: {
  requestStepId: string | null;
  config: ResolvedConfig;
  wasFallback: boolean;
  operation: () => T;
}): T {
  try {
    return args.operation();
  } catch (error) {
    recordTrajectoryModelFailed({
      requestStepId: args.requestStepId,
      providerId: args.config.providerId,
      modelId: args.config.model,
      role: "primary",
      wasFallback: args.wasFallback,
      error,
      retryable: false,
    });
    throw error;
  }
}
