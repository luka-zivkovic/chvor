/**
 * Discovers and parses an OpenAPI/Swagger spec for a service.
 *
 * Strategy:
 *   1. Probe well-known spec paths on the baseUrl in parallel.
 *   2. Query APIs.guru for a listed spec.
 *   3. Returns normalized operations — callers decide how to filter them.
 *
 * All network calls are HTTPS-only and behind assertSafeSynthesizedUrl.
 */

import { parse as parseYaml } from "yaml";
import { assertSafeSynthesizedUrl } from "./synthesized-caller.ts";

const SPEC_FETCH_TIMEOUT_MS = 8000;
const MAX_SPEC_BYTES = 2 * 1024 * 1024; // 2MB
const APIS_GURU_LIST = "https://api.apis.guru/v2/list.json";

const WELL_KNOWN_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/swagger.yaml",
  "/v2/api-docs",
  "/v3/api-docs",
  "/.well-known/openapi",
  "/api/openapi.json",
  "/api-docs",
];

export interface NormalizedOperation {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  pathParams: Array<{ name: string; type: "string" | "integer"; required: boolean }>;
  queryParams: Array<{ name: string; type: "string" | "integer" | "boolean"; required: boolean; description?: string }>;
  bodySchema: Record<string, unknown> | null;
  securityRequired?: string[];
}

export interface DiscoveredSpec {
  specUrl: string;
  baseUrl?: string;
  operations: NormalizedOperation[];
}

// ── Fetch helpers ──────────────────────────────────────────────

async function safeFetchText(rawUrl: string): Promise<string | null> {
  try {
    await assertSafeSynthesizedUrl(rawUrl);
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < MAX_SPEC_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          size += value.byteLength;
        }
      }
      if (size >= MAX_SPEC_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
  } catch {
    return null;
  }
}

function tryParseSpec(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      return parseYaml(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function isLikelyOpenApi(doc: Record<string, unknown> | null): boolean {
  if (!doc) return false;
  return (
    typeof doc.openapi === "string" ||
    typeof doc.swagger === "string" ||
    !!doc.paths
  );
}

// ── Spec normalization ─────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "op_$1");
}

function deriveOperationName(method: string, path: string, op: Record<string, unknown>): string {
  const opId = op.operationId;
  if (typeof opId === "string" && opId.length > 0) return toSlug(opId);

  const cleanPath = path.replace(/\{[^}]+\}/g, "").replace(/\//g, "_");
  return toSlug(`${method}_${cleanPath}`) || toSlug(method);
}

function extractBaseUrl(doc: Record<string, unknown>): string | undefined {
  const servers = doc.servers;
  if (Array.isArray(servers) && servers.length > 0) {
    const first = servers[0] as Record<string, unknown>;
    if (typeof first.url === "string") return first.url;
  }
  // Swagger 2.0
  const host = doc.host;
  const basePath = doc.basePath;
  if (typeof host === "string") {
    return `https://${host}${typeof basePath === "string" ? basePath : ""}`;
  }
  return undefined;
}

interface RawParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: { type?: string };
  type?: string;
  description?: string;
}

function mapParamType(raw: string | undefined): "string" | "integer" | "boolean" {
  if (raw === "integer" || raw === "number") return "integer";
  if (raw === "boolean") return "boolean";
  return "string";
}

function normalizeOperations(doc: Record<string, unknown>): NormalizedOperation[] {
  const paths = doc.paths;
  if (!paths || typeof paths !== "object") return [];
  const out: NormalizedOperation[] = [];

  const METHODS = ["get", "post", "put", "patch", "delete"] as const;

  for (const [path, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as Record<string, unknown>;

    // Path-level parameters apply to all methods
    const pathLevelParams = (pathItem.parameters as RawParameter[] | undefined) ?? [];

    for (const method of METHODS) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as Record<string, unknown>;

      const allParams = [
        ...pathLevelParams,
        ...((op.parameters as RawParameter[] | undefined) ?? []),
      ];

      const pathParams = allParams
        .filter((p) => p.in === "path")
        .map((p) => ({
          name: p.name ?? "",
          type: mapParamType(p.schema?.type ?? p.type) === "integer" ? "integer" as const : "string" as const,
          required: p.required !== false,
        }))
        .filter((p) => p.name);

      const queryParams = allParams
        .filter((p) => p.in === "query")
        .map((p) => ({
          name: p.name ?? "",
          type: mapParamType(p.schema?.type ?? p.type),
          required: p.required === true,
          description: p.description,
        }))
        .filter((p) => p.name);

      let bodySchema: Record<string, unknown> | null = null;
      const reqBody = op.requestBody as Record<string, unknown> | undefined;
      if (reqBody && typeof reqBody === "object") {
        const content = reqBody.content as Record<string, unknown> | undefined;
        if (content) {
          const json = (content["application/json"] ?? content["application/x-www-form-urlencoded"]) as
            | Record<string, unknown>
            | undefined;
          if (json && typeof json === "object" && json.schema && typeof json.schema === "object") {
            bodySchema = json.schema as Record<string, unknown>;
          }
        }
      }

      const security = op.security as Array<Record<string, string[]>> | undefined;
      const securityRequired = security?.flatMap((s) => Object.keys(s)) ?? undefined;

      out.push({
        name: deriveOperationName(method, path, op),
        description:
          (typeof op.summary === "string" ? op.summary : undefined) ??
          (typeof op.description === "string" ? op.description.slice(0, 200) : undefined) ??
          `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase() as NormalizedOperation["method"],
        path,
        pathParams,
        queryParams,
        bodySchema,
        securityRequired,
      });
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return out.filter((o) => {
    if (seen.has(o.name)) return false;
    seen.add(o.name);
    return true;
  });
}

// ── APIs.guru lookup ──────────────────────────────────────────

interface ApisGuruEntry {
  versions: Record<string, { swaggerUrl?: string; openapiVer?: string; info?: { title?: string } }>;
}

async function findInApisGuru(serviceName: string): Promise<string | null> {
  try {
    const text = await safeFetchText(APIS_GURU_LIST);
    if (!text) return null;
    const index = JSON.parse(text) as Record<string, ApisGuruEntry>;

    const q = serviceName.toLowerCase();
    for (const [apiKey, entry] of Object.entries(index)) {
      const keyLower = apiKey.toLowerCase();
      if (keyLower === q || keyLower.startsWith(`${q}.`) || keyLower.includes(`:${q}`)) {
        const versions = Object.keys(entry.versions);
        const latest = versions.sort().reverse()[0];
        const version = entry.versions[latest];
        if (version?.swaggerUrl) return version.swaggerUrl;
      }
    }

    // Fuzzy: match on title
    for (const entry of Object.values(index)) {
      for (const version of Object.values(entry.versions)) {
        if (version.info?.title?.toLowerCase().includes(q)) {
          if (version.swaggerUrl) return version.swaggerUrl;
        }
      }
    }

    return null;
  } catch (err) {
    console.warn("[spec-fetcher] APIs.guru lookup failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Public entry ──────────────────────────────────────────────

export async function discoverOpenApi(args: {
  serviceName: string;
  baseUrl?: string;
  hintedSpecUrl?: string;
}): Promise<DiscoveredSpec | null> {
  const { serviceName, baseUrl, hintedSpecUrl } = args;

  // Hinted URL first
  if (hintedSpecUrl) {
    const text = await safeFetchText(hintedSpecUrl);
    const doc = text ? tryParseSpec(text) : null;
    if (doc && isLikelyOpenApi(doc)) {
      return {
        specUrl: hintedSpecUrl,
        baseUrl: extractBaseUrl(doc),
        operations: normalizeOperations(doc),
      };
    }
  }

  // Probe well-known paths
  if (baseUrl) {
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const urls = WELL_KNOWN_PATHS.map((p) => `${base}${p}`);
    const results = await Promise.all(urls.map(async (u) => ({ url: u, text: await safeFetchText(u) })));
    for (const r of results) {
      if (!r.text) continue;
      const doc = tryParseSpec(r.text);
      if (doc && isLikelyOpenApi(doc)) {
        return {
          specUrl: r.url,
          baseUrl: extractBaseUrl(doc) ?? baseUrl,
          operations: normalizeOperations(doc),
        };
      }
    }
  }

  // APIs.guru
  const apisGuruUrl = await findInApisGuru(serviceName);
  if (apisGuruUrl) {
    const text = await safeFetchText(apisGuruUrl);
    const doc = text ? tryParseSpec(text) : null;
    if (doc && isLikelyOpenApi(doc)) {
      return {
        specUrl: apisGuruUrl,
        baseUrl: extractBaseUrl(doc),
        operations: normalizeOperations(doc),
      };
    }
  }

  return null;
}

/**
 * Pick a manageable subset of operations for a synthesized tool.
 * Prefers GET and read-like names; drops admin/debug endpoints.
 */
export function selectOperations(
  operations: NormalizedOperation[],
  maxCount = 50,
): NormalizedOperation[] {
  const scored = operations.map((op) => {
    let score = 0;
    if (op.method === "GET") score += 5;
    if (/^(list|get|fetch|search|find|read)/.test(op.name)) score += 3;
    if (/admin|debug|internal|deprecated/i.test(op.path) || /admin|debug|internal|deprecated/i.test(op.name)) score -= 10;
    if (op.method === "DELETE") score -= 2;
    return { op, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map((s) => s.op);
}
