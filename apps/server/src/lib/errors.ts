import { containsSensitiveData, redactSensitiveData } from "./sensitive-filter.ts";
import type { ErrorCategory } from "./error-logger.ts";

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

export type ChvorErrorCode =
  // Credential / integration
  | "credential.missing"
  | "credential.invalid"
  | "credential.expired"
  | "credential.test_failed"
  | "credential.encryption_failed"
  | "credential.refresh_failed"
  // Synthesized tools / OpenAPI
  | "synth.spec_invalid"
  | "synth.spec_unreachable"
  | "synth.endpoint_not_found"
  | "synth.url_blocked"
  | "synth.approval_denied"
  | "synth.approval_timeout"
  | "synth.repair_budget_exhausted"
  | "synth.upstream_error"
  | "synth.parse_error"
  // LLM
  | "llm.no_provider"
  | "llm.rate_limited"
  | "llm.upstream_error"
  | "llm.tool_loop_exhausted"
  | "llm.fallback_exhausted"
  | "llm.invalid_response"
  // Memory
  | "memory.write_failed"
  | "memory.read_failed"
  | "memory.embedding_failed"
  | "memory.not_found"
  // Sandbox
  | "sandbox.docker_unavailable"
  | "sandbox.image_missing"
  | "sandbox.exec_failed"
  | "sandbox.timeout"
  | "sandbox.resource_limit"
  // Generic
  | "internal.unexpected"
  | "internal.invariant_violation"
  | "input.invalid"
  | "input.too_large"
  | "auth.required"
  | "auth.forbidden"
  | "rate_limit.exceeded";

// HTTP status defaults per code family — used by the route serializer when no
// explicit status is set on the error.
const DEFAULT_HTTP_STATUS: Record<string, number> = {
  "credential.missing": 401,
  "credential.invalid": 401,
  "credential.expired": 401,
  "credential.test_failed": 400,
  "credential.encryption_failed": 500,
  "credential.refresh_failed": 401,
  "synth.spec_invalid": 502,
  "synth.spec_unreachable": 502,
  "synth.endpoint_not_found": 404,
  "synth.url_blocked": 400,
  "synth.approval_denied": 403,
  "synth.approval_timeout": 408,
  "synth.repair_budget_exhausted": 429,
  "synth.upstream_error": 502,
  "synth.parse_error": 502,
  "llm.no_provider": 503,
  "llm.rate_limited": 429,
  "llm.upstream_error": 502,
  "llm.tool_loop_exhausted": 500,
  "llm.fallback_exhausted": 503,
  "llm.invalid_response": 502,
  "memory.write_failed": 500,
  "memory.read_failed": 500,
  "memory.embedding_failed": 500,
  "memory.not_found": 404,
  "sandbox.docker_unavailable": 503,
  "sandbox.image_missing": 503,
  "sandbox.exec_failed": 500,
  "sandbox.timeout": 408,
  "sandbox.resource_limit": 429,
  "internal.unexpected": 500,
  "internal.invariant_violation": 500,
  "input.invalid": 400,
  "input.too_large": 413,
  "auth.required": 401,
  "auth.forbidden": 403,
  "rate_limit.exceeded": 429,
};

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface ChvorErrorOptions {
  /** Stable machine-readable code. */
  code: ChvorErrorCode;
  /** Maps onto error-logger ErrorCategory for the JSONL log. */
  category?: ErrorCategory;
  /** Arbitrary structured context — redacted before serialization. */
  context?: Record<string, unknown>;
  /** Underlying cause — preserved on the prototype chain. */
  cause?: unknown;
  /** Override HTTP status when the error is rendered into a response. */
  httpStatus?: number;
  /** True if this error is safe to surface verbatim to the user/canvas. */
  userFacing?: boolean;
}

export class ChvorError extends Error {
  readonly code: ChvorErrorCode;
  readonly category: ErrorCategory;
  readonly context: Record<string, unknown>;
  readonly httpStatus: number;
  readonly userFacing: boolean;

  constructor(message: string, opts: ChvorErrorOptions) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.category = opts.category ?? "system_error";
    this.context = opts.context ?? {};
    this.httpStatus = opts.httpStatus ?? DEFAULT_HTTP_STATUS[opts.code] ?? 500;
    this.userFacing = opts.userFacing ?? false;
    // Make `instanceof` work reliably across compiled output.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): SerializedError {
    return serializeError(this);
  }
}

// ---------------------------------------------------------------------------
// Subclasses — narrow constructors for the common shapes
// ---------------------------------------------------------------------------

export class CredentialError extends ChvorError {
  constructor(
    message: string,
    opts: Omit<ChvorErrorOptions, "code" | "category"> & {
      code:
        | "credential.missing"
        | "credential.invalid"
        | "credential.expired"
        | "credential.test_failed"
        | "credential.encryption_failed"
        | "credential.refresh_failed";
    },
  ) {
    super(message, { ...opts, category: "capability_error" });
  }
}

export class SynthesizedToolError extends ChvorError {
  constructor(
    message: string,
    opts: Omit<ChvorErrorOptions, "code" | "category"> & {
      code:
        | "synth.spec_invalid"
        | "synth.spec_unreachable"
        | "synth.endpoint_not_found"
        | "synth.url_blocked"
        | "synth.approval_denied"
        | "synth.approval_timeout"
        | "synth.repair_budget_exhausted"
        | "synth.upstream_error"
        | "synth.parse_error";
    },
  ) {
    super(message, { ...opts, category: "tool_failure" });
  }
}

export class LLMError extends ChvorError {
  constructor(
    message: string,
    opts: Omit<ChvorErrorOptions, "code" | "category"> & {
      code:
        | "llm.no_provider"
        | "llm.rate_limited"
        | "llm.upstream_error"
        | "llm.tool_loop_exhausted"
        | "llm.fallback_exhausted"
        | "llm.invalid_response";
    },
  ) {
    super(message, { ...opts, category: "llm_error" });
  }
}

export class MemoryError extends ChvorError {
  constructor(
    message: string,
    opts: Omit<ChvorErrorOptions, "code" | "category"> & {
      code:
        | "memory.write_failed"
        | "memory.read_failed"
        | "memory.embedding_failed"
        | "memory.not_found";
    },
  ) {
    super(message, { ...opts, category: "system_error" });
  }
}

export class SandboxError extends ChvorError {
  constructor(
    message: string,
    opts: Omit<ChvorErrorOptions, "code" | "category"> & {
      code:
        | "sandbox.docker_unavailable"
        | "sandbox.image_missing"
        | "sandbox.exec_failed"
        | "sandbox.timeout"
        | "sandbox.resource_limit";
    },
  ) {
    super(message, { ...opts, category: "sandbox_error" });
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedError {
  code: ChvorErrorCode;
  message: string;
  category: ErrorCategory;
  context?: Record<string, unknown>;
  cause?: { message: string; code?: string } | undefined;
  /** Stack trace — only included when DEBUG_ERRORS=1 (never in canvas/route output). */
  stack?: string;
}

function safeRedactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return containsSensitiveData(value) ? "[REDACTED]" : redactSensitiveData(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Defensive: stringify-then-redact for anything else, capped to avoid runaway logs.
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    if (json.length > 8_000) return `[truncated:${json.length}b]`;
    return containsSensitiveData(json) ? "[REDACTED]" : value;
  } catch {
    return "[unserializable]";
  }
}

function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = safeRedactValue(v);
  }
  return out;
}

/**
 * Convert any error (typed or not) into a safe JSON shape suitable for HTTP
 * responses, WebSocket events, and the canvas. Never leaks raw secrets.
 */
export function serializeError(err: unknown): SerializedError {
  if (isChvorError(err)) {
    const out: SerializedError = {
      code: err.code,
      message: containsSensitiveData(err.message)
        ? "[REDACTED — contains sensitive data]"
        : redactSensitiveData(err.message),
      category: err.category,
    };
    if (Object.keys(err.context).length > 0) {
      out.context = redactContext(err.context);
    }
    if (err.cause instanceof Error) {
      const causeMsg = containsSensitiveData(err.cause.message)
        ? "[REDACTED]"
        : redactSensitiveData(err.cause.message);
      const causeCode =
        typeof (err.cause as unknown as { code?: unknown }).code === "string"
          ? ((err.cause as unknown as { code: string }).code)
          : undefined;
      out.cause = { message: causeMsg, ...(causeCode ? { code: causeCode } : {}) };
    }
    if (process.env.DEBUG_ERRORS === "1" && err.stack) {
      out.stack = redactSensitiveData(err.stack);
    }
    return out;
  }

  // Non-typed errors — coerce into the same shape with a generic code.
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  const out: SerializedError = {
    code: "internal.unexpected",
    message: containsSensitiveData(message)
      ? "[REDACTED — contains sensitive data]"
      : redactSensitiveData(message),
    category: "system_error",
  };
  if (process.env.DEBUG_ERRORS === "1" && err instanceof Error && err.stack) {
    out.stack = redactSensitiveData(err.stack);
  }
  return out;
}

export function isChvorError(err: unknown): err is ChvorError {
  return err instanceof ChvorError;
}

/** Pull a stable HTTP status off any error — falls back to 500 for non-Chvor errors. */
export function httpStatusFor(err: unknown): number {
  if (isChvorError(err)) return err.httpStatus;
  return 500;
}

/**
 * Wrap a thrown value as a ChvorError if it isn't one already. Useful at boundary
 * layers (route handlers, orchestrator callbacks) so downstream code can rely on
 * the typed shape without losing the original cause.
 */
export function wrapError(
  err: unknown,
  fallback: { code: ChvorErrorCode; message?: string; context?: Record<string, unknown> },
): ChvorError {
  if (isChvorError(err)) return err;
  const message =
    fallback.message ??
    (err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error");
  return new ChvorError(message, {
    code: fallback.code,
    cause: err,
    context: fallback.context,
  });
}
