import type {
  EvaluationCaseDocumentV1,
  EvaluationCaseRecord,
  EvaluationCaseUpdate,
} from "@chvor/shared";

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface CreateEvaluationCaseRequest {
  document: EvaluationCaseDocumentV1;
}

export interface EvaluationCasePage {
  records: EvaluationCaseRecord[];
  nextCursor: string | null;
}

export interface EvaluationCaseRevisionPage {
  revisions: EvaluationCaseRecord[];
  nextCursor: string | null;
}

export interface TrajectoryEvaluationSource {
  input: unknown;
  output?: unknown;
  outputOmitted: boolean;
}

function pageQuery(options: { limit?: number; cursor?: string }): string {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function createEvaluationCasesApi(
  request: JsonRequest,
  requestText: (path: string) => Promise<string>
) {
  return {
    list: (options: { limit?: number; cursor?: string } = {}) =>
      request<EvaluationCasePage>(`/evaluation-cases${pageQuery(options)}`),
    get: (id: string) =>
      request<{ evaluationCase: EvaluationCaseRecord }>(
        `/evaluation-cases/${encodeURIComponent(id)}`
      ).then(({ evaluationCase }) => evaluationCase),
    revisions: (id: string, options: { limit?: number; cursor?: string } = {}) =>
      request<EvaluationCaseRevisionPage>(
        `/evaluation-cases/${encodeURIComponent(id)}/revisions${pageQuery(options)}`
      ),
    sourceFromTrajectory: (trajectoryId: string) =>
      request<{ source: TrajectoryEvaluationSource }>(
        `/trajectories/${encodeURIComponent(trajectoryId)}/evaluation-source`
      ).then(({ source }) => source),
    create: (body: CreateEvaluationCaseRequest) =>
      request<{ evaluationCase: EvaluationCaseRecord }>("/evaluation-cases", {
        method: "POST",
        body: JSON.stringify(body),
      }).then(({ evaluationCase }) => evaluationCase),
    update: (id: string, body: EvaluationCaseUpdate) =>
      request<{ evaluationCase: EvaluationCaseRecord }>(
        `/evaluation-cases/${encodeURIComponent(id)}`,
        { method: "PUT", body: JSON.stringify(body) }
      ).then(({ evaluationCase }) => evaluationCase),
    export: (id: string) => requestText(`/evaluation-cases/${encodeURIComponent(id)}/export`),
    import: (document: EvaluationCaseDocumentV1) =>
      request<{ evaluationCase: EvaluationCaseRecord }>("/evaluation-cases/import", {
        method: "POST",
        body: JSON.stringify(document),
      }).then(({ evaluationCase }) => evaluationCase),
  };
}
