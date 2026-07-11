export interface ServerApiOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export class ServerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export function createServerApi(options: ServerApiOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const config = readConfig();
  const defaultBase = `http://127.0.0.1:${config.port}/api`;
  const base = (options.baseUrl ?? process.env.CHVOR_URL ?? defaultBase).replace(/\/$/, "");
  const token =
    options.token ?? process.env.CHVOR_TOKEN ?? (base === defaultBase ? config.token : undefined);
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      signal: options.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: T;
      error?: string;
      detail?: string;
    };
    if (!response.ok) {
      throw new ServerApiError(
        [body.error, body.detail].filter(Boolean).join(": ") ||
          `Server returned ${response.status}`,
        response.status
      );
    }
    return (body.data ?? body) as T;
  }
  return {
    importCase: (document: unknown) =>
      request<{ evaluationCase: { id: string; revision: number } }>("/evaluation-cases/import", {
        method: "POST",
        body: JSON.stringify(document),
      }).then(({ evaluationCase }) => evaluationCase),
    runEvaluation: (body: unknown) =>
      request<{ report: EvaluationReport }>("/evaluation-runs", {
        method: "POST",
        body: JSON.stringify(body),
      }).then(({ report }) => report),
    compareEvaluations: async (
      baseline: string,
      candidate: string
    ): Promise<EvaluationComparison> => {
      let cursor: string | null = null;
      let regressions = 0;
      let improvements = 0;
      const rows: EvaluationComparison["rows"] = [];
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page: EvaluationComparison & { nextCursor: string | null } = await request(
          `/evaluation-runs/compare?baseline=${encodeURIComponent(baseline)}&candidate=${encodeURIComponent(candidate)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        regressions = page.regressions;
        improvements = page.improvements;
        rows.push(...page.rows);
        cursor = page.nextCursor;
        if (!cursor) return { regressions, improvements, rows };
      }
      throw new ServerApiError("Evaluation comparison exceeded the pagination limit");
    },
  };
}

export interface EvaluationReport {
  id: string;
  passed: boolean;
  status: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    criticalFailed: number;
    totalCostUsd: number | null;
    totalLatencyMs: number;
  };
  cases: Array<{
    snapshot: { document: { name: string } };
    passed: boolean;
    assertions: Array<{ kind: string; status: string; message: string }>;
  }>;
}

export interface EvaluationComparison {
  regressions: number;
  improvements: number;
  rows: Array<{
    caseName: string;
    classification: string;
    costDeltaUsd: number | null;
    latencyDeltaMs: number | null;
  }>;
}
import { readConfig } from "./config.js";
