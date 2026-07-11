import type {
  EvaluationComparison,
  EvaluationRunConfiguration,
  EvaluationRunReport,
} from "@chvor/shared";

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface EvaluationRunSummary {
  id: string;
  engine: string;
  provider: string;
  model: string;
  status: EvaluationRunReport["status"];
  passed: boolean;
  completedAt: string;
  caseCount: number;
  passedCaseCount: number;
  failedCaseCount: number;
  costUsd: number | null;
  totalLatencyMs: number;
}

export interface CreateEvaluationRunRequest {
  cases: Array<{ id: string; revision?: number; critical?: boolean }>;
  configuration: Omit<EvaluationRunConfiguration, "promptHash">;
}

function query(options: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function createEvaluationRunsApi(request: JsonRequest) {
  return {
    create: (body: CreateEvaluationRunRequest) =>
      request<{ report: EvaluationRunReport }>("/evaluation-runs", {
        method: "POST",
        body: JSON.stringify(body),
      }).then(({ report }) => report),
    list: (options: { limit?: number; cursor?: string } = {}) =>
      request<{ runs: EvaluationRunSummary[]; nextCursor: string | null }>(
        `/evaluation-runs${query(options)}`
      ),
    get: (id: string) =>
      request<{ report: EvaluationRunReport }>(`/evaluation-runs/${encodeURIComponent(id)}`).then(
        ({ report }) => report
      ),
    cases: (id: string, options: { limit?: number; cursor?: string } = {}) =>
      request<{ cases: unknown[]; nextCursor: string | null }>(
        `/evaluation-runs/${encodeURIComponent(id)}/cases${query(options)}`
      ),
    compare: (
      baseline: string,
      candidate: string,
      options: { limit?: number; cursor?: string } = {}
    ) =>
      request<EvaluationComparison & { nextCursor: string | null }>(
        `/evaluation-runs/compare${query({ baseline, candidate, ...options })}`
      ),
  };
}
