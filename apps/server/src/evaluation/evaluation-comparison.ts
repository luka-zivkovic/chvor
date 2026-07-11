import {
  evaluationComparisonSchema,
  type EvaluationComparison,
  type EvaluationRunCaseResult,
  type EvaluationRunReport,
} from "@chvor/shared";

function key(result: EvaluationRunCaseResult): string {
  return `${result.snapshot.caseId ?? "inline"}:${result.snapshot.revision ?? "inline"}:${result.snapshot.documentHash}`;
}

export function compareEvaluationReports(
  baseline: EvaluationRunReport,
  candidate: EvaluationRunReport
): EvaluationComparison {
  if (baseline.status !== "completed" || candidate.status !== "completed") {
    throw new Error("only completed evaluation runs can be compared");
  }
  const baselineByKey = new Map(baseline.cases.map((entry) => [key(entry), entry]));
  const candidateByKey = new Map(candidate.cases.map((entry) => [key(entry), entry]));
  const orderedKeys = [
    ...baseline.cases.map(key),
    ...candidate.cases.map(key).filter((entry) => !baselineByKey.has(entry)),
  ];
  const rows = orderedKeys.map((entry, position) => {
    const before = baselineByKey.get(entry);
    const after = candidateByKey.get(entry);
    const classification = !before
      ? "candidate-only"
      : !after
        ? "baseline-only"
        : before.passed && !after.passed
          ? "regression"
          : !before.passed && after.passed
            ? "improvement"
            : before.passed
              ? "unchanged-passed"
              : "unchanged-failed";
    const beforeCost = before?.observation.costUsd;
    const afterCost = after?.observation.costUsd;
    return {
      position,
      caseName: (after ?? before)?.snapshot.document.name ?? "Unknown case",
      classification,
      baselinePassed: before?.passed ?? null,
      candidatePassed: after?.passed ?? null,
      costDeltaUsd:
        typeof beforeCost === "number" && typeof afterCost === "number"
          ? afterCost - beforeCost
          : null,
      latencyDeltaMs:
        before && after ? after.observation.latencyMs - before.observation.latencyMs : null,
    };
  });
  return evaluationComparisonSchema.parse({
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    regressions: rows.filter(({ classification }) => classification === "regression").length,
    improvements: rows.filter(({ classification }) => classification === "improvement").length,
    rows,
  });
}
