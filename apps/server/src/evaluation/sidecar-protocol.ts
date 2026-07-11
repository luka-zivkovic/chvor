import type {
  EvaluationCaseSnapshot,
  EvaluationObservation,
  EvaluationRunConfiguration,
} from "@chvor/shared";

export interface EvaluationSidecarRequest {
  configuration: EvaluationRunConfiguration;
  cases: EvaluationCaseSnapshot[];
  credential: { apiKey: string; baseUrl?: string };
}

export interface EvaluationSidecarCaseResult {
  observation: EvaluationObservation;
  secretDetected: boolean;
}

export interface EvaluationSidecarResponse {
  cases: EvaluationSidecarCaseResult[];
}
