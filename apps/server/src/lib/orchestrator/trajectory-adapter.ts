import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  ActorType,
  ApprovalRecord,
  CanonicalTrajectoryStepV1,
  CanonicalTrajectoryV1,
  ChatMessage,
  ExecutionEvent,
  TrajectoryActor,
  TrajectoryError,
  TrajectoryJsonValue,
  TrajectoryModelUsage,
  TrajectoryOrigin,
  TrajectoryToolCall,
} from "@chvor/shared";
import {
  appendTrajectoryStep,
  createTrajectory,
  markTrajectoryInterrupted,
  updateTrajectoryMetadata,
} from "../../db/trajectory-store.ts";
import {
  sanitizeTrajectoryPayload,
  sanitizeTrajectoryString,
} from "./trajectory-payload.ts";
import { throwIfAborted, waitForAbortSideEffectSettlement, withAbort } from "./abort.ts";

export interface TrajectoryRunContext {
  id?: string;
  origin: TrajectoryOrigin;
  actor: TrajectoryActor;
  title?: string;
  attributes?: TrajectoryJsonValue;
}

export interface TrajectoryCaptureStore {
  createTrajectory(input: CanonicalTrajectoryV1): CanonicalTrajectoryV1;
  appendTrajectoryStep(
    trajectoryId: string,
    input: CanonicalTrajectoryStepV1
  ): CanonicalTrajectoryStepV1;
  updateTrajectoryMetadata(
    trajectoryId: string,
    update: Record<string, unknown>
  ): CanonicalTrajectoryV1;
  markTrajectoryInterrupted(
    trajectoryId: string,
    input: {
      status: "failed" | "aborted";
      completedAt?: string;
      durationMs?: number;
      error?: TrajectoryError;
      summary?: string;
    }
  ): CanonicalTrajectoryV1;
}

export interface TrajectoryCaptureDependencies {
  store: TrajectoryCaptureStore;
  now: () => Date;
  id: () => string;
  logger: { warn(message: string, error?: unknown): void };
}

export interface RunWithTrajectoryCaptureArgs<T> {
  messages: readonly ChatMessage[];
  emit: (event: ExecutionEvent) => void;
  execute: (trackedEmit: (event: ExecutionEvent) => void) => Promise<T>;
  context?: TrajectoryRunContext;
  sessionId?: string;
  channelType?: string;
  channelId?: string;
  loopId?: string;
  auditActor?: { type: ActorType; id: string | null };
  abortSignal?: AbortSignal;
  /** Exact secrets already known by the caller before initial input is persisted. */
  initialSecrets?: Iterable<string>;
  dependencies?: Partial<TrajectoryCaptureDependencies>;
}

export interface TrajectoryModelStartedInput {
  providerId: string;
  modelId: string;
  role?: string;
  wasFallback?: boolean;
  input?: unknown;
  round?: number;
  startedAt?: string | number | Date;
}

export interface TrajectoryModelFinishedInput {
  requestStepId?: string | null;
  providerId?: string;
  modelId?: string;
  role?: string;
  wasFallback?: boolean;
  output?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  finishReason?: string;
  completedAt?: string | number | Date;
}

export interface TrajectoryModelFailedInput {
  requestStepId?: string | null;
  providerId?: string;
  modelId?: string;
  role?: string;
  wasFallback?: boolean;
  error: unknown;
  retryable?: boolean;
  completedAt?: string | number | Date;
}

export type CapturedToolKind = TrajectoryToolCall["toolKind"];

export interface TrajectoryToolInvocation {
  toolCallId: string;
  toolName: string;
  args: unknown;
  toolKind?: CapturedToolKind;
  credentialRefs?: TrajectoryToolCall["credentialRefs"];
  startedAt?: string | number | Date;
}

export interface TrajectoryToolOutcome {
  toolCallId: string;
  toolName?: string;
  result?: unknown;
  error?: unknown;
  success?: boolean;
  completedAt?: string | number | Date;
}

export interface TrajectoryToolRoundInput {
  round: number;
  calls: readonly TrajectoryToolInvocation[];
  results: readonly TrajectoryToolOutcome[];
}

export interface TrajectoryToolStartedInput {
  round: number;
  call: TrajectoryToolInvocation;
  status?: "completed" | "skipped";
}

export interface TrajectoryToolPlanInput {
  round: number;
  calls: readonly TrajectoryToolInvocation[];
}

export interface TrajectoryToolFinishedInput {
  round: number;
  result: TrajectoryToolOutcome;
}

const defaultStore: TrajectoryCaptureStore = {
  createTrajectory,
  appendTrajectoryStep,
  updateTrajectoryMetadata,
  markTrajectoryInterrupted,
};

const defaultDependencies: TrajectoryCaptureDependencies = {
  store: defaultStore,
  now: () => new Date(),
  id: randomUUID,
  logger: console,
};

interface ModelRequestState {
  providerId: string;
  modelId: string;
  role?: string;
  wasFallback: boolean;
  startedAt: string;
}

interface ToolCallStepState {
  id: string;
  startedAt: string;
  round: number;
  toolCall: TrajectoryToolCall;
}

interface ActiveTrajectoryRun {
  id: string;
  parent?: ActiveTrajectoryRun;
  origin: TrajectoryOrigin;
  startedAt: string;
  latestAt: string;
  sequence: number;
  disabled: boolean;
  closed: boolean;
  warned: boolean;
  dependencies: TrajectoryCaptureDependencies;
  modelRequests: Map<string, ModelRequestState>;
  modelUsage: TrajectoryModelUsage[];
  lastModelStepId?: string;
  toolCallSteps: Map<string, ToolCallStepState>;
  toolResultSteps: Set<string>;
  plannedToolCalls: Map<string, TrajectoryToolStartedInput>;
  secrets: Set<string>;
}

interface CapturedStepInput {
  kind: CanonicalTrajectoryStepV1["kind"];
  status: CanonicalTrajectoryStepV1["status"];
  startedAt: string;
  attributes: unknown;
  customType?: string;
  parentStepId?: string | null;
  name?: string;
  actor?: TrajectoryActor;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  modelUsage?: TrajectoryModelUsage;
  toolCall?: TrajectoryToolCall;
  approval?: CanonicalTrajectoryStepV1["approval"];
  error?: TrajectoryError;
}

const activeRuns = new AsyncLocalStorage<ActiveTrajectoryRun>();
export const TRAJECTORY_SECRET_RETENTION_LIMIT = 256;
export const TRAJECTORY_SECRET_RETENTION_MS = 30 * 60 * 1000;

const retainedTrajectorySecrets = new Map<string, number>();
let retainedSecretExpiryTimer: ReturnType<typeof setTimeout> | null = null;

function pruneRetainedTrajectorySecrets(now = Date.now()): void {
  for (const [secret, expiresAt] of retainedTrajectorySecrets) {
    if (expiresAt <= now) retainedTrajectorySecrets.delete(secret);
  }
}

function scheduleRetainedSecretExpiry(): void {
  if (retainedSecretExpiryTimer) clearTimeout(retainedSecretExpiryTimer);
  retainedSecretExpiryTimer = null;
  if (retainedTrajectorySecrets.size === 0) return;

  const nextExpiry = Math.min(...retainedTrajectorySecrets.values());
  retainedSecretExpiryTimer = setTimeout(() => {
    retainedSecretExpiryTimer = null;
    pruneRetainedTrajectorySecrets();
    scheduleRetainedSecretExpiry();
  }, Math.max(1, nextExpiry - Date.now()));
  retainedSecretExpiryTimer.unref();
}

function retainTrajectorySecrets(secrets: readonly string[]): void {
  const expiresAt = Date.now() + TRAJECTORY_SECRET_RETENTION_MS;
  pruneRetainedTrajectorySecrets();
  for (const secret of secrets) {
    // Refreshing insertion order makes capacity eviction least-recently-seen.
    retainedTrajectorySecrets.delete(secret);
    retainedTrajectorySecrets.set(secret, expiresAt);
  }
  while (retainedTrajectorySecrets.size > TRAJECTORY_SECRET_RETENTION_LIMIT) {
    const oldest = retainedTrajectorySecrets.keys().next().value;
    if (oldest === undefined) break;
    retainedTrajectorySecrets.delete(oldest);
  }
  scheduleRetainedSecretExpiry();
}

function retainedSecretSnapshot(): string[] {
  try {
    pruneRetainedTrajectorySecrets();
    scheduleRetainedSecretExpiry();
    return [...retainedTrajectorySecrets.keys()];
  } catch {
    clearTrajectorySecrets();
    return [];
  }
}

function dependencies(
  overrides: Partial<TrajectoryCaptureDependencies> | undefined
): TrajectoryCaptureDependencies {
  return {
    store: overrides?.store ?? defaultDependencies.store,
    now: overrides?.now ?? defaultDependencies.now,
    id: overrides?.id ?? defaultDependencies.id,
    logger: overrides?.logger ?? defaultDependencies.logger,
  };
}

function warnAndDisable(run: ActiveTrajectoryRun, operation: string, error: unknown): void {
  run.disabled = true;
  if (run.warned) return;
  run.warned = true;
  try {
    run.dependencies.logger.warn(
      `[trajectory] ${operation} failed for ${run.id}; capture disabled for this run`,
      error
    );
  } catch {
    // A diagnostic logger must never affect the engine path.
  }
}

function attempt(run: ActiveTrajectoryRun, operation: string, action: () => void): boolean {
  if (run.disabled) return false;
  try {
    action();
    return true;
  } catch (error) {
    warnAndDisable(run, operation, error);
    return false;
  }
}

function instant(value: string | number | Date | undefined, run: ActiveTrajectoryRun): string {
  const date = value === undefined ? run.dependencies.now() : new Date(value);
  const candidate = date.toISOString();
  if (Date.parse(candidate) < Date.parse(run.latestAt)) return run.latestAt;
  run.latestAt = candidate;
  return candidate;
}

function durationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, Math.round(Date.parse(completedAt) - Date.parse(startedAt)));
}

function errorDetails(
  error: unknown,
  category: string,
  retryable = false,
  fallbackCode = "execution_error",
  secrets: Iterable<string> = []
): TrajectoryError {
  const object =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const name = typeof object?.name === "string" ? object.name : undefined;
  const codeValue = typeof object?.code === "string" ? object.code : name;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: (codeValue || fallbackCode).slice(0, 128),
    category: category.slice(0, 128),
    message: sanitizeTrajectoryString(message, secrets),
    retryable,
  };
}

function inferredToolKind(toolName: string): CapturedToolKind {
  if (toolName.startsWith("native__")) return "native";
  if (toolName.startsWith("skill__")) return "skill";
  if (toolName.startsWith("mcp__")) return "mcp";
  return "synthesized";
}

function appendStep(
  run: ActiveTrajectoryRun,
  operation: string,
  input: CapturedStepInput
): string | null {
  if (run.disabled || run.closed) return null;
  let id: string;
  try {
    id = run.dependencies.id();
  } catch (error) {
    warnAndDisable(run, `${operation} id generation`, error);
    return null;
  }
  const step = {
    ...input,
    attributes: sanitizeTrajectoryPayload(input.attributes, run.secrets),
    ...(input.input === undefined
      ? {}
      : { input: sanitizeTrajectoryPayload(input.input, run.secrets) }),
    ...(input.output === undefined
      ? {}
      : { output: sanitizeTrajectoryPayload(input.output, run.secrets) }),
    ...(input.error === undefined
      ? {}
      : {
          error: {
            ...input.error,
            message: sanitizeTrajectoryString(input.error.message, run.secrets),
          },
        }),
    id,
    trajectoryId: run.id,
    sequence: run.sequence,
    artifacts: [],
  } as unknown as CanonicalTrajectoryStepV1;
  const succeeded = attempt(run, operation, () => {
    run.dependencies.store.appendTrajectoryStep(run.id, step);
  });
  if (!succeeded) return null;
  run.sequence += 1;
  return id;
}

function updateMetadata(
  run: ActiveTrajectoryRun,
  operation: string,
  update: Record<string, unknown>
): boolean {
  if (run.closed) return false;
  const safeUpdate = { ...update };
  for (const key of ["input", "output", "attributes"] as const) {
    if (key in safeUpdate) safeUpdate[key] = sanitizeTrajectoryPayload(safeUpdate[key], run.secrets);
  }
  return attempt(run, operation, () => {
    run.dependencies.store.updateTrajectoryMetadata(run.id, safeUpdate);
  });
}

function idFromPrefixedSession(sessionId: string | undefined, prefix: string): string | undefined {
  if (!sessionId?.startsWith(prefix)) return undefined;
  const value = sessionId.slice(prefix.length);
  return value || undefined;
}

function deriveContext<T>(args: RunWithTrajectoryCaptureArgs<T>): TrajectoryRunContext {
  if (args.context) return args.context;

  const actor = args.auditActor;
  const sessionId = args.sessionId;
  const channelType = args.channelType;
  const channelId = args.channelId;

  if (args.loopId) {
    return {
      origin: {
        kind: "cognitive-loop",
        loopId: args.loopId,
        ...(sessionId ? { sessionId } : {}),
        ...(channelType ? { channelType } : {}),
        ...(channelId ? { channelId } : {}),
      },
      actor: actor ?? { type: "daemon", id: null },
      attributes: { contextDerived: true },
    };
  }

  if (channelType === "scheduler") {
    const scheduleId =
      idFromPrefixedSession(sessionId, "sched-wf-") ?? idFromPrefixedSession(sessionId, "sched-");
    return {
      origin: {
        kind: "schedule",
        ...(scheduleId ? { scheduleId } : {}),
        ...(sessionId ? { sessionId } : {}),
        channelType,
      },
      actor: { type: "schedule", id: scheduleId ?? actor?.id ?? null },
      attributes: { contextDerived: true },
    };
  }

  if (channelType === "webhook" || actor?.type === "webhook") {
    const webhookId = actor?.type === "webhook" ? (actor.id ?? undefined) : undefined;
    return {
      origin: {
        kind: "webhook",
        ...(webhookId ? { webhookId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(channelType ? { channelType } : {}),
      },
      actor: { type: "webhook", id: webhookId ?? null },
      attributes: { contextDerived: true },
    };
  }

  if (channelType === "daemon" || actor?.type === "daemon") {
    return {
      origin: {
        kind: "daemon",
        ...(sessionId ? { sessionId } : {}),
        ...(channelType ? { channelType } : {}),
      },
      actor: { type: "daemon", id: actor?.id ?? null },
      attributes: { contextDerived: true },
    };
  }

  const canonicalActor: TrajectoryActor = actor
    ? { type: actor.type, id: actor.id }
    : { type: "session", id: sessionId ?? null };
  if (channelType === "web") {
    return {
      origin: {
        kind: "web-chat",
        ...(sessionId ? { sessionId } : {}),
        channelType,
        ...(channelId ? { channelId } : {}),
      },
      actor: canonicalActor,
      attributes: { contextDerived: true },
    };
  }
  if (channelType) {
    return {
      origin: {
        kind: "channel",
        ...(sessionId ? { sessionId } : {}),
        channelType,
        ...(channelId ? { channelId } : {}),
      },
      actor: canonicalActor,
      attributes: { contextDerived: true },
    };
  }
  return {
    origin: { kind: sessionId ? "api" : "system", ...(sessionId ? { sessionId } : {}) },
    actor: actor
      ? canonicalActor
      : { type: sessionId ? "session" : "system", id: sessionId ?? null },
    attributes: { contextDerived: true },
  };
}

function isRoundLimited(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as Record<string, unknown>).hitRoundLimit === true
  );
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function fallbackCompletedAt(run: ActiveTrajectoryRun): string {
  try {
    return run.dependencies.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function fallbackFinalizeSuccess<T>(run: ActiveTrajectoryRun, result: T): void {
  try {
    const completedAt = fallbackCompletedAt(run);
    run.dependencies.store.updateTrajectoryMetadata(run.id, {
      status: isRoundLimited(result) ? "round-limited" : "completed",
      completedAt,
      durationMs: durationMs(run.startedAt, completedAt),
      output: sanitizeTrajectoryPayload(result, run.secrets),
      modelUsage: run.modelUsage,
    });
  } catch {
    // The engine result remains authoritative when persistence is unavailable.
  }
}

function fallbackFinalizeError(run: ActiveTrajectoryRun, error: unknown, aborted: boolean): void {
  try {
    const completedAt = fallbackCompletedAt(run);
    run.dependencies.store.markTrajectoryInterrupted(run.id, {
      status: aborted ? "aborted" : "failed",
      completedAt,
      durationMs: durationMs(run.startedAt, completedAt),
      error: errorDetails(
        error,
        aborted ? "aborted" : "execution",
        false,
        aborted ? "aborted" : "execution_error",
        run.secrets
      ),
    });
  } catch {
    // The engine error remains authoritative when persistence is unavailable.
  }
}

function finalizeSuccess<T>(run: ActiveTrajectoryRun, result: T): void {
  if (run.disabled) {
    fallbackFinalizeSuccess(run, result);
    return;
  }
  try {
    const completedAt = instant(undefined, run);
    appendStep(run, "record output", {
      kind: "message.output",
      status: "completed",
      name: "Engine output",
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
      output: result,
      attributes: {},
    });
    if (run.disabled) {
      fallbackFinalizeSuccess(run, result);
      return;
    }
    const status = isRoundLimited(result) ? "round-limited" : "completed";
    appendStep(run, "record terminal outcome", {
      kind: "trajectory.completed",
      status: "completed",
      name: status === "round-limited" ? "Round limit reached" : "Trajectory completed",
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
      attributes: { outcome: status },
    });
    if (run.disabled) {
      fallbackFinalizeSuccess(run, result);
      return;
    }
    const finalized = updateMetadata(run, "finalize trajectory", {
      status,
      completedAt,
      durationMs: durationMs(run.startedAt, completedAt),
      output: result,
      modelUsage: run.modelUsage,
    });
    if (!finalized) fallbackFinalizeSuccess(run, result);
  } catch (error) {
    warnAndDisable(run, "finalize trajectory", error);
    fallbackFinalizeSuccess(run, result);
  }
}

function finalizeError(run: ActiveTrajectoryRun, error: unknown, aborted: boolean): void {
  if (run.disabled) {
    fallbackFinalizeError(run, error, aborted);
    return;
  }
  try {
    const completedAt = instant(undefined, run);
    for (const [toolCallId, planned] of run.plannedToolCalls) {
      const call =
        run.toolCallSteps.get(toolCallId) ?? appendToolCallStep(run, { ...planned, status: "skipped" });
      if (!call || run.toolResultSteps.has(toolCallId)) continue;
      appendToolResultStep(run, {
        round: call.round,
        result: {
          toolCallId,
          toolName: call.toolCall.toolName,
          error,
          success: false,
          completedAt,
        },
      });
    }
    for (const [toolCallId, call] of run.toolCallSteps) {
      if (run.toolResultSteps.has(toolCallId)) continue;
      appendToolResultStep(run, {
        round: call.round,
        result: { toolCallId, error, success: false, completedAt },
      });
    }
    const details = errorDetails(
      error,
      aborted ? "aborted" : "execution",
      false,
      aborted ? "aborted" : "execution_error",
      run.secrets
    );
    appendStep(run, "record interrupted outcome", {
      kind: "trajectory.failed",
      status: aborted ? "aborted" : "failed",
      name: aborted ? "Trajectory aborted" : "Trajectory failed",
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
      error: details,
      attributes: { outcome: aborted ? "aborted" : "failed" },
    });
    if (run.disabled) {
      fallbackFinalizeError(run, error, aborted);
      return;
    }
    const finalized = attempt(run, "finalize interrupted trajectory", () => {
      run.dependencies.store.markTrajectoryInterrupted(run.id, {
        status: aborted ? "aborted" : "failed",
        completedAt,
        durationMs: durationMs(run.startedAt, completedAt),
        error: details,
      });
    });
    if (!finalized) fallbackFinalizeError(run, error, aborted);
  } catch (captureError) {
    warnAndDisable(run, "finalize interrupted trajectory", captureError);
    fallbackFinalizeError(run, error, aborted);
  }
}

/**
 * Capture one engine invocation without changing its result, exception, or
 * public event stream. Instrumentation is deliberately best-effort: the first
 * store failure opens a per-run circuit breaker and is logged once.
 */
export async function runWithTrajectoryCapture<T>(
  args: RunWithTrajectoryCaptureArgs<T>
): Promise<T> {
  const parent = activeRuns.getStore();
  const context = deriveContext(args);
  const deps = dependencies(args.dependencies);
  let bootstrapError: unknown;
  let runId = context.id;
  if (!runId) {
    try {
      runId = deps.id();
    } catch (error) {
      bootstrapError = error;
      runId = randomUUID();
    }
  }
  let startedAt: string;
  try {
    startedAt = deps.now().toISOString();
  } catch (error) {
    bootstrapError ??= error;
    startedAt = new Date().toISOString();
  }
  const run: ActiveTrajectoryRun = {
    id: runId,
    ...(parent ? { parent } : {}),
    origin: context.origin,
    startedAt,
    latestAt: startedAt,
    sequence: 0,
    disabled: false,
    closed: false,
    warned: false,
    dependencies: deps,
    modelRequests: new Map(),
    modelUsage: [],
    toolCallSteps: new Map(),
    toolResultSteps: new Set(),
    plannedToolCalls: new Map(),
    secrets: new Set([
      ...retainedSecretSnapshot(),
      ...(parent?.secrets ?? []),
      ...(args.initialSecrets ?? []),
    ]),
  };

  if (bootstrapError !== undefined) {
    warnAndDisable(run, "initialize trajectory capture", bootstrapError);
  }

  attempt(run, "create trajectory", () => {
    deps.store.createTrajectory({
      schemaVersion: 1,
      id: run.id,
      origin: context.origin,
      actor: context.actor,
      status: "running",
      ...(context.title === undefined ? {} : { title: context.title }),
      startedAt: run.startedAt,
      input: sanitizeTrajectoryPayload([...args.messages], run.secrets),
      modelUsage: [],
      steps: [],
      artifacts: [],
      labels: [],
      attributes: sanitizeTrajectoryPayload(context.attributes ?? {}, run.secrets),
    });
  });

  appendStep(run, "record trajectory start", {
    kind: "trajectory.started",
    status: "completed",
    name: "Trajectory started",
    startedAt: run.startedAt,
    completedAt: run.startedAt,
    durationMs: 0,
    input: { messageCount: args.messages.length },
    attributes: {},
  });

  const trackedEmit = (event: ExecutionEvent): void => {
    if (!run.closed && !args.abortSignal?.aborted) args.emit(event);
  };

  return activeRuns.run(run, async () => {
    try {
      throwIfAborted(args.abortSignal);
      const execution = args.execute(trackedEmit);
      const result = await withAbort(execution, args.abortSignal, true);
      finalizeSuccess(run, result);
      return result;
    } catch (error) {
      const aborted = isAbort(error, args.abortSignal);
      if (aborted && args.abortSignal) {
        await waitForAbortSideEffectSettlement(args.abortSignal);
      }
      finalizeError(run, error, aborted);
      throw error;
    } finally { run.closed = true; }
  });
}

/** The current captured run ID, or null outside a tracked invocation. */
export function getActiveTrajectoryId(): string | null {
  return activeRuns.getStore()?.id ?? null;
}

/** The canonical origin inherited by nested engine invocations. */
export function getActiveTrajectoryOrigin(): TrajectoryOrigin | null {
  const origin = activeRuns.getStore()?.origin;
  return origin ? { ...origin } : null;
}

/** Register exact secret values that must be scrubbed for the rest of this run. */
export function registerTrajectorySecrets(secrets: Iterable<string>): void {
  try {
    const values = Array.from(secrets).filter((secret) => secret.length > 0);
    retainTrajectorySecrets(values);
    for (let run = activeRuns.getStore(); run; run = run.parent) {
      for (const secret of values) run.secrets.add(secret);
    }
  } catch {
    // Secret tracking is best-effort and must never affect execution.
    clearTrajectorySecrets();
  }
}

export function clearTrajectorySecrets(): void {
  retainedTrajectorySecrets.clear();
  try {
    if (retainedSecretExpiryTimer) clearTimeout(retainedSecretExpiryTimer);
  } catch {
    // Lifecycle cleanup must remain failure-isolated from engine execution.
  }
  retainedSecretExpiryTimer = null;
}

/** Operational cache bounds without exposing any retained credential values. */
export function getTrajectorySecretRetentionStats(): {
  size: number;
  limit: number;
  retentionMs: number;
} {
  pruneRetainedTrajectorySecrets();
  return {
    size: retainedTrajectorySecrets.size,
    limit: TRAJECTORY_SECRET_RETENTION_LIMIT,
    retentionMs: TRAJECTORY_SECRET_RETENTION_MS,
  };
}

/** Record an immutable model request and return its step ID for correlation. */
export function recordTrajectoryModelStarted(input: TrajectoryModelStartedInput): string | null {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return null;
  try {
    const startedAt = instant(input.startedAt, run);
    const usage: TrajectoryModelUsage = {
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.role ? { role: input.role } : {}),
      wasFallback: input.wasFallback ?? false,
      inputTokens: 0,
      outputTokens: 0,
    };
    const id = appendStep(run, "record model request", {
      kind: "model.request",
      status: "completed",
      name: `${input.providerId}/${input.modelId}`,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      ...(input.input === undefined ? {} : { input: input.input }),
      modelUsage: usage,
      attributes: input.round === undefined ? {} : { round: input.round },
    });
    if (id) {
      run.modelRequests.set(id, {
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.role ? { role: input.role } : {}),
        wasFallback: input.wasFallback ?? false,
        startedAt,
      });
    }
    return id;
  } catch (error) {
    warnAndDisable(run, "record model request", error);
    return null;
  }
}

function modelUsageFor(
  run: ActiveTrajectoryRun,
  input: TrajectoryModelFinishedInput | TrajectoryModelFailedInput
): { request?: ModelRequestState; usage: TrajectoryModelUsage } | null {
  const request = input.requestStepId ? run.modelRequests.get(input.requestStepId) : undefined;
  const providerId = input.providerId ?? request?.providerId;
  const modelId = input.modelId ?? request?.modelId;
  if (!providerId || !modelId) return null;
  const role = input.role ?? request?.role;
  const usage: TrajectoryModelUsage = {
    providerId,
    modelId,
    ...(role ? { role } : {}),
    wasFallback: input.wasFallback ?? request?.wasFallback ?? false,
    inputTokens: "inputTokens" in input ? (input.inputTokens ?? 0) : 0,
    outputTokens: "outputTokens" in input ? (input.outputTokens ?? 0) : 0,
    ...(input instanceof Object && "reasoningTokens" in input && input.reasoningTokens !== undefined
      ? { reasoningTokens: input.reasoningTokens }
      : {}),
    ...(input instanceof Object &&
    "cachedInputTokens" in input &&
    input.cachedInputTokens !== undefined
      ? { cachedInputTokens: input.cachedInputTokens }
      : {}),
    ...(input instanceof Object && "totalTokens" in input && input.totalTokens !== undefined
      ? { totalTokens: input.totalTokens }
      : {}),
    ...(input instanceof Object && "costUsd" in input && input.costUsd !== undefined
      ? { costUsd: input.costUsd }
      : {}),
    ...(input instanceof Object && "latencyMs" in input && input.latencyMs !== undefined
      ? { latencyMs: input.latencyMs }
      : {}),
  };
  return { request, usage };
}

/** Record an immutable successful model response. */
export function recordTrajectoryModelFinished(input: TrajectoryModelFinishedInput): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    const resolved = modelUsageFor(run, input);
    if (!resolved) throw new Error("model response requires providerId/modelId or a requestStepId");
    const completedAt = instant(input.completedAt, run);
    const startedAt = resolved.request?.startedAt ?? completedAt;
    const usage = {
      ...resolved.usage,
      ...(input.latencyMs === undefined ? { latencyMs: durationMs(startedAt, completedAt) } : {}),
    };
    const id = appendStep(run, "record model response", {
      kind: "model.response",
      status: "completed",
      name: `${usage.providerId}/${usage.modelId}`,
      ...(input.requestStepId ? { parentStepId: input.requestStepId } : {}),
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      ...(input.output === undefined ? {} : { output: input.output }),
      modelUsage: usage,
      attributes: input.finishReason ? { finishReason: input.finishReason } : {},
    });
    if (id) {
      run.lastModelStepId = id;
      run.modelUsage.push(usage);
    }
  } catch (error) {
    warnAndDisable(run, "record model response", error);
  }
}

/** Record an immutable failed model response/attempt. */
export function recordTrajectoryModelFailed(input: TrajectoryModelFailedInput): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    const resolved = modelUsageFor(run, input);
    if (!resolved) throw new Error("model failure requires providerId/modelId or a requestStepId");
    const completedAt = instant(input.completedAt, run);
    const startedAt = resolved.request?.startedAt ?? completedAt;
    const usage = { ...resolved.usage, latencyMs: durationMs(startedAt, completedAt) };
    const id = appendStep(run, "record model failure", {
      kind: "model.response",
      status: "failed",
      name: `${usage.providerId}/${usage.modelId}`,
      ...(input.requestStepId ? { parentStepId: input.requestStepId } : {}),
      startedAt,
      completedAt,
      durationMs: durationMs(startedAt, completedAt),
      modelUsage: usage,
      error: errorDetails(input.error, "model", input.retryable ?? false, "model_error", run.secrets),
      attributes: { outcome: "failed" },
    });
    if (id) {
      run.lastModelStepId = id;
      run.modelUsage.push(usage);
    }
  } catch (error) {
    warnAndDisable(run, "record model failure", error);
  }
}

function toolOutcomeFailed(outcome: TrajectoryToolOutcome): boolean {
  if (outcome.success !== undefined) return !outcome.success;
  if (outcome.error !== undefined) return true;
  return typeof outcome.result === "object" && outcome.result !== null && "error" in outcome.result;
}

function appendToolCallStep(
  run: ActiveTrajectoryRun,
  input: TrajectoryToolStartedInput
): ToolCallStepState | null {
  const existing = run.toolCallSteps.get(input.call.toolCallId);
  if (existing) return existing;
  const calledAt = instant(input.call.startedAt, run);
  const toolCall: TrajectoryToolCall = {
    toolCallId: input.call.toolCallId,
    toolName: input.call.toolName,
    toolKind: input.call.toolKind ?? inferredToolKind(input.call.toolName),
    credentialRefs: input.call.credentialRefs ?? [],
  };
  const callStepId = appendStep(run, "record tool call", {
    kind: "tool.call",
    status: input.status ?? "completed",
    name: input.call.toolName,
    ...(run.lastModelStepId ? { parentStepId: run.lastModelStepId } : {}),
    startedAt: calledAt,
    completedAt: calledAt,
    durationMs: 0,
    input: input.call.args,
    toolCall,
    attributes: { round: input.round },
  });
  if (!callStepId) return null;
  const state = { id: callStepId, startedAt: calledAt, round: input.round, toolCall };
  run.toolCallSteps.set(input.call.toolCallId, state);
  return state;
}

/** Record a tool call before security/approval gating begins. */
export function recordTrajectoryToolStarted(input: TrajectoryToolStartedInput): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    appendToolCallStep(run, input);
  } catch (error) {
    warnAndDisable(run, "record tool call", error);
  }
}

/** Remember model-returned calls so aborts can terminalize calls not yet executed. */
export function recordTrajectoryToolPlan(input: TrajectoryToolPlanInput): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled || run.closed) return;
  for (const call of input.calls) {
    run.plannedToolCalls.set(call.toolCallId, { round: input.round, call });
  }
}

function appendToolResultStep(
  run: ActiveTrajectoryRun,
  input: TrajectoryToolFinishedInput
): string | null {
  if (run.toolResultSteps.has(input.result.toolCallId)) return null;
  const callStep = run.toolCallSteps.get(input.result.toolCallId);
  if (!callStep) return null;
  const completedAt = instant(input.result.completedAt, run);
  const failed = toolOutcomeFailed(input.result);
  const failure =
    input.result.error ??
    (failed &&
    typeof input.result.result === "object" &&
    input.result.result !== null &&
    "error" in input.result.result
      ? (input.result.result as { error: unknown }).error
      : "tool call failed");
  const stepId = appendStep(run, "record tool result", {
    kind: "tool.result",
    status: failed ? "failed" : "completed",
    name: input.result.toolName ?? callStep.toolCall.toolName,
    parentStepId: callStep.id,
    startedAt: callStep.startedAt,
    completedAt,
    durationMs: durationMs(callStep.startedAt, completedAt),
    ...(input.result.result === undefined ? {} : { output: input.result.result }),
    toolCall: callStep.toolCall,
    ...(failed ? { error: errorDetails(failure, "tool", false, "tool_error", run.secrets) } : {}),
    attributes: { round: input.round },
  });
  if (stepId) run.toolResultSteps.add(input.result.toolCallId);
  return stepId;
}

/** Record a tool result as soon as the current engine produces it. */
export function recordTrajectoryToolFinished(input: TrajectoryToolFinishedInput): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    appendToolResultStep(run, input);
  } catch (error) {
    warnAndDisable(run, "record tool result", error);
  }
}

/** Record call/result pairs for one model tool round in model-returned order. */
export function recordTrajectoryToolRound(input: TrajectoryToolRoundInput): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    const results = new Map(input.results.map((result) => [result.toolCallId, result]));
    for (const call of input.calls) {
      const callStep = appendToolCallStep(run, { round: input.round, call });
      if (!callStep || run.disabled) return;
      const outcome = results.get(call.toolCallId);
      appendToolResultStep(run, {
        round: input.round,
        result: outcome ?? {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          error: "tool result missing",
          success: false,
        },
      });
      if (run.disabled) return;
    }
  } catch (error) {
    warnAndDisable(run, "record tool round", error);
  }
}

function approvalReference(record: ApprovalRecord) {
  return {
    approvalId: record.id,
    kind: record.kind,
    risk: record.risk,
    status: record.status,
    ...(record.decision === null ? {} : { decision: record.decision }),
    requestedAt: new Date(record.createdAt).toISOString(),
    ...(record.decidedAt === null ? {} : { resolvedAt: new Date(record.decidedAt).toISOString() }),
  };
}

/** Record a durable pending approval and move the trajectory to waiting. */
export function recordTrajectoryApprovalRequested(
  record: ApprovalRecord,
  toolCallId?: string
): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    if (record.status !== "pending") throw new Error("approval request record must be pending");
    const startedAt = instant(record.createdAt, run);
    appendStep(run, "record approval request", {
      kind: "approval.requested",
      status: "waiting",
      name: record.toolName,
      ...(toolCallId && run.toolCallSteps.has(toolCallId)
        ? { parentStepId: run.toolCallSteps.get(toolCallId)?.id }
        : {}),
      startedAt,
      input: { args: record.args, reasons: record.reasons },
      approval: approvalReference(record),
      attributes: {
        actionId: record.actionId,
        checkpointId: record.checkpointId,
        expiresAt: new Date(record.expiresAt).toISOString(),
      },
    });
    if (run.disabled) return;
    updateMetadata(run, "mark trajectory waiting", { status: "waiting" });
  } catch (error) {
    warnAndDisable(run, "record approval request", error);
  }
}

/** Record the durable decision and return the trajectory to running. */
export function recordTrajectoryApprovalResolved(
  record: ApprovalRecord,
  toolCallId?: string
): void {
  const run = activeRuns.getStore();
  if (!run || run.disabled) return;
  try {
    if (record.status === "pending" || record.decidedAt === null) {
      throw new Error("approval resolution record must be terminal");
    }
    if (!updateMetadata(run, "resume trajectory after approval", { status: "running" })) return;
    const completedAt = instant(record.decidedAt, run);
    appendStep(run, "record approval resolution", {
      kind: "approval.resolved",
      status: "completed",
      name: record.toolName,
      ...(toolCallId && run.toolCallSteps.has(toolCallId)
        ? { parentStepId: run.toolCallSteps.get(toolCallId)?.id }
        : {}),
      startedAt: completedAt,
      completedAt,
      durationMs: 0,
      output: { status: record.status, decision: record.decision, decidedBy: record.decidedBy },
      approval: approvalReference(record),
      attributes: {
        actionId: record.actionId,
        checkpointId: record.checkpointId,
      },
    });
  } catch (error) {
    warnAndDisable(run, "record approval resolution", error);
  }
}
