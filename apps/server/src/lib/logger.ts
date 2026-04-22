import pino, { type Logger } from "pino";
import { redactSensitiveData } from "./sensitive-filter.ts";

// Single shared logger. Pretty-printed for the dev TTY, JSON in production.
//
// Levels:
//   trace=10 / debug=20 / info=30 / warn=40 / error=50 / fatal=60
//
// LOG_LEVEL env var overrides. Tests run silent by default to keep CI noise low.
const env = process.env.NODE_ENV ?? "development";
const isProd = env === "production";
const isTest = env === "test" || process.env.VITEST === "1";

function pickLevel(): pino.LevelWithSilent {
  const explicit = process.env.LOG_LEVEL?.toLowerCase();
  if (explicit && ["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(explicit)) {
    return explicit as pino.LevelWithSilent;
  }
  if (isTest) return "silent";
  if (isProd) return "info";
  return "info";
}

export const logger: Logger = pino({
  level: pickLevel(),
  base: { service: "chvor-server" },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Final-stage redaction: pino's own paths catch the obvious shapes; the
  // formatter pass below does pattern-based scrubbing for free-text fields.
  redact: {
    paths: [
      "headers.authorization",
      "headers.cookie",
      'headers["x-api-key"]',
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["x-api-key"]',
      "credentials",
      "credential",
      "apiKey",
      "api_key",
      "secret",
      "token",
      "password",
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    log(obj) {
      // Best-effort string scrub on the rendered payload — pattern-based, so
      // we never serialize a leaked secret to disk.
      if (typeof obj.msg === "string") obj.msg = redactSensitiveData(obj.msg);
      return obj;
    },
  },
});

export type RequestLogContext = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  sessionId?: string;
  apiKeyId?: string;
};

export function logRequest(ctx: RequestLogContext): void {
  const level = ctx.status >= 500 ? "error" : ctx.status >= 400 ? "warn" : "info";
  logger[level](
    {
      requestId: ctx.requestId,
      method: ctx.method,
      path: ctx.path,
      status: ctx.status,
      durationMs: ctx.durationMs,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}),
    },
    "request",
  );
}
