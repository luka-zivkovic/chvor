/**
 * Shared URL-building and auth-application logic for synthesized tool calls.
 *
 * This module is the SINGLE source of truth used by both the live caller
 * (`synthesized-caller.ts`) and the pre-save probe (`probe.ts`). Keeping one
 * copy means "Test connection" always predicts live behavior — previously the
 * two had byte-identical duplicates that could silently diverge.
 */

import type { ConnectionConfig } from "@chvor/shared";

/** Strip CR/LF to prevent header injection via credential values or templates. */
export function stripCrlf(input: string): string {
  return input.replace(/[\r\n]+/g, "");
}

export function substitutePathParams(
  path: string,
  pathParams: Record<string, string | number>
): string {
  return path.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const k = key.trim();
    if (!(k in pathParams)) return match;
    return encodeURIComponent(String(pathParams[k]));
  });
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function buildUrl(
  baseUrl: string,
  endpointPath: string,
  pathParams: Record<string, string | number>,
  queryParams: Record<string, string | number | boolean>
): string {
  const path = substitutePathParams(endpointPath, pathParams);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(normalizeBaseUrl(baseUrl) + normalizedPath);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Resolve the primary secret value from credential data.
 *
 * `accessToken` wins when present: it is only ever set by an OAuth flow and is
 * the live token. A credential can carry BOTH a stale `apiKey` (e.g. from a
 * prior manual entry before the integration was re-linked via OAuth) and a
 * fresh `accessToken`; preferring `accessToken` ensures we never send the
 * stale key. Falls back to `apiKey` then `token` for non-OAuth credentials.
 */
export function resolvePrimarySecret(data: Record<string, string>): string {
  return data.accessToken ?? data.apiKey ?? data.token ?? "";
}

export function applyAuth(
  headers: Record<string, string>,
  url: URL,
  auth: ConnectionConfig["auth"],
  data: Record<string, string>
): void {
  const apiKey = resolvePrimarySecret(data);

  const renderTemplate = (template: string | undefined, fallback: string): string => {
    const t = template ?? fallback;
    const rendered = t.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => data[k] ?? "");
    return stripCrlf(rendered);
  };

  switch (auth.scheme) {
    case "bearer":
      headers["Authorization"] = renderTemplate(auth.headerTemplate, `Bearer ${apiKey}`);
      break;
    case "api-key-header":
      headers[stripCrlf(auth.headerName ?? "x-api-key")] = renderTemplate(
        auth.headerTemplate,
        apiKey
      );
      break;
    case "basic": {
      const user = data.username ?? "";
      const pass = data.password ?? apiKey;
      headers["Authorization"] =
        `Basic ${Buffer.from(`${stripCrlf(user)}:${stripCrlf(pass)}`).toString("base64")}`;
      break;
    }
    case "query-param":
      url.searchParams.set(auth.queryParam ?? "api_key", apiKey);
      break;
    case "custom":
      if (auth.headerName && auth.headerTemplate) {
        headers[stripCrlf(auth.headerName)] = renderTemplate(auth.headerTemplate, apiKey);
      }
      break;
  }
}
