import type { ConnectionConfig } from "@chvor/shared";
import { withSecretSeal, extractSecretValues } from "../credential-injector.ts";
import { pinnedHttpsRequest, resolveSafeSynthesizedTarget, type PinnedResponse, type ResolvedTarget } from "./network.ts";
import { applyAuth, buildUrl, stripCrlf } from "./auth.ts";

const MAX_TIMEOUT_MS = 600_000;

// ── Generic credential probe (Track 0.3) ───────────────────────

export interface ProbeResult {
  ok: boolean;
  status?: number;
  /** Resolved URL we actually called (helps diagnose typos in baseUrl). */
  probedUrl?: string;
  /** Short body preview when failing. */
  bodyPreview?: string;
  error?: string;
  durationMs: number;
}

/**
 * Probes a service with a candidate ConnectionConfig + credential data, before
 * the credential is saved. Useful as a pre-save sanity check so users find out
 * about wrong baseUrls / auth-scheme mismatches immediately rather than minutes
 * later when the AI tries to use the credential.
 *
 * Strategy: a single GET against `probePath` (or `/` if omitted) on baseUrl, with
 * full SSRF gates and the same auth pipeline as live calls. Any 2xx/3xx is a
 * pass; 401/403 is a fail with the diagnosis carried in the body preview.
 *
 * Note: many APIs serve a 404 at root but a 200 at e.g. `/v1/me`. Callers
 * should pass a `probePath` when known. Without one, a 404 is treated as
 * "host reachable but path unknown" and reported as ambiguous — not a hard
 * failure — because the credential may still be valid for actual endpoints.
 */
export async function probeCredentialConfig(args: {
  connection: ConnectionConfig;
  data: Record<string, string>;
  probePath?: string;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const started = Date.now();
  const { connection, data, probePath } = args;
  const timeoutMs = Math.min(args.timeoutMs ?? 15_000, MAX_TIMEOUT_MS);

  if (!connection.baseUrl) {
    return { ok: false, error: "connectionConfig.baseUrl is required for probe", durationMs: 0 };
  }
  const baseUrl = connection.baseUrl;

  return withSecretSeal(extractSecretValues(data), async () => {
    const path = probePath && probePath.trim() ? probePath.trim() : "/";
    let target: ResolvedTarget;
    try {
      const urlStr = buildUrl(baseUrl, path, {}, {});
      target = await resolveSafeSynthesizedTarget(urlStr);
    } catch (err) {
      return {
        ok: false,
        error: `URL safety check failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }

    const headersObj: Record<string, string> = { Accept: "application/json" };
    if (connection.headers) {
      for (const [k, v] of Object.entries(connection.headers)) {
        headersObj[stripCrlf(k)] = stripCrlf(v);
      }
    }
    applyAuth(headersObj, target.url, connection.auth, data);

    let response: PinnedResponse;
    try {
      response = await pinnedHttpsRequest({
        target,
        method: "GET",
        headers: headersObj,
        timeoutMs,
        maxBytes: 64 * 1024,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        probedUrl: target.url.toString(),
        error: `network error: ${msg}`,
        durationMs: Date.now() - started,
      };
    }

    const bodyPreview = response.body.toString("utf-8").slice(0, 500);
    const status = response.status;
    const probedUrl = target.url.toString();

    if (status >= 200 && status < 400) {
      return { ok: true, status, probedUrl, durationMs: Date.now() - started };
    }
    // 404 with no probePath: ambiguous — the host responded, the credential may still be valid.
    if (status === 404 && !probePath) {
      return {
        ok: true,
        status,
        probedUrl,
        bodyPreview:
          "host reachable, root path returned 404 — credential not validated, but baseUrl works",
        durationMs: Date.now() - started,
      };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        status,
        probedUrl,
        bodyPreview,
        error: `auth rejected (${status}) — check the credential value and auth scheme`,
        durationMs: Date.now() - started,
      };
    }
    return {
      ok: false,
      status,
      probedUrl,
      bodyPreview,
      error: `HTTP ${status} ${response.statusText}`,
      durationMs: Date.now() - started,
    };
  });
}
