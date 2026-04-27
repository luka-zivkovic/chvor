import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { logRequest } from "../lib/logger.ts";

// Request logger — emits one structured line per request with method, path,
// status, latency, requestId, and (when available) session/api-key id.
//
// The requestId is exposed on the response as X-Request-Id so clients can
// correlate failures with server-side logs.
export const requestLogger = createMiddleware(async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId" as never, requestId);
  c.header("X-Request-Id", requestId);

  const start = Date.now();
  let status = 0;
  try {
    await next();
    status = c.res.status;
  } catch (err) {
    // Hono's onError handler sets status, but if we throw past it, log 500
    // before re-raising so the failure isn't invisible.
    status = 500;
    throw err;
  } finally {
    const sessionId = c.get("sessionId" as never) as string | undefined;
    const apiKeyId = c.get("apiKeyId" as never) as string | undefined;
    logRequest({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status,
      durationMs: Date.now() - start,
      ...(sessionId ? { sessionId } : {}),
      ...(apiKeyId ? { apiKeyId } : {}),
    });
  }
});
