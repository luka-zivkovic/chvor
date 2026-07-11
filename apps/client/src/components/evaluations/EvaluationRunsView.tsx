import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EvaluationComparison,
  EvaluationCaseRecord,
  EvaluationRunReport,
} from "@chvor/shared";
import type { EvaluationRunSummary } from "../../lib/evaluation-runs-api";
import { api } from "../../lib/api";
import { EmptyState } from "../ui/empty-state";

const EVALUATION_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "minimax",
  "openrouter",
  "groq",
  "mistral",
  "ollama-cloud",
  "ollama",
  "lmstudio",
  "vllm",
] as const satisfies readonly EvaluationRunReport["configuration"]["providerId"][];

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function money(value: number | null): string {
  return value === null ? "unknown" : `$${value.toFixed(6)}`;
}

export function evaluationToolStub(name: string, effect: "read" | "write" = "write") {
  return {
    name,
    description: `Deterministic simulated response for ${name}`,
    effect,
    approval: effect === "write" ? ("auto-deny" as const) : ("auto-approve" as const),
    result: { simulated: true, tool: name },
  };
}

export function EvaluationRunsView() {
  const [runs, setRuns] = useState<EvaluationRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [report, setReport] = useState<EvaluationRunReport | null>(null);
  const [cases, setCases] = useState<EvaluationCaseRecord[]>([]);
  const [caseCursor, setCaseCursor] = useState<string | null>(null);
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [readTools, setReadTools] = useState<string[]>([]);
  const [providerId, setProviderId] =
    useState<EvaluationRunReport["configuration"]["providerId"]>("openai");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("You are Chvor. Complete the evaluation input safely.");
  const [maxCost, setMaxCost] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [maxLatency, setMaxLatency] = useState("");
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [comparison, setComparison] = useState<EvaluationComparison | null>(null);
  const [comparisonCursor, setComparisonCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.evaluationRuns.list({ limit: 20, ...(cursor ? { cursor } : {}) });
      setRuns((current) => (cursor ? [...current, ...page.runs] : page.runs));
      setNextCursor(page.nextCursor);
      if (!cursor && page.runs[0]) setReport(await api.evaluationRuns.get(page.runs[0].id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load evaluation runs");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCases = useCallback(async (cursor?: string) => {
    try {
      const page = await api.evaluationCases.list({ limit: 20, ...(cursor ? { cursor } : {}) });
      setCases((current) => (cursor ? [...current, ...page.records] : page.records));
      setCaseCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load cases");
    }
  }, []);

  useEffect(() => {
    void loadRuns();
    void loadCases();
  }, [loadCases, loadRuns]);

  const selectedRecords = useMemo(
    () => cases.filter(({ id }) => selectedCases.includes(id)),
    [cases, selectedCases]
  );
  const toolNames = useMemo(
    () =>
      [
        ...new Set(
          selectedRecords.flatMap(({ document }) => [
            ...document.requiredTools,
            ...document.forbiddenTools,
          ])
        ),
      ].sort(),
    [selectedRecords]
  );

  const run = async () => {
    if (!selectedRecords.length || !modelId.trim()) {
      setError("Select at least one case and enter a model ID.");
      return;
    }
    if (maxCost && (!inputPrice || !outputPrice)) {
      setError("A maximum cost requires input and output prices per million tokens.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const created = await api.evaluationRuns.create({
        cases: selectedRecords.map(({ id, revision }) => ({ id, revision, critical: true })),
        configuration: {
          engineId: "chvor-isolated-v1",
          providerId,
          modelId: modelId.trim(),
          prompt,
          temperature: 0,
          maxRounds: 4,
          caseTimeoutMs: 120_000,
          limits: {
            ...(maxCost ? { maxCostUsdPerCase: Number(maxCost) } : {}),
            ...(maxLatency ? { maxLatencyMsPerCase: Number(maxLatency) } : {}),
          },
          ...(inputPrice && outputPrice
            ? {
                pricing: {
                  inputUsdPerMillion: Number(inputPrice),
                  outputUsdPerMillion: Number(outputPrice),
                },
              }
            : {}),
          tools: toolNames.map((name) =>
            evaluationToolStub(name, readTools.includes(name) ? "read" : "write")
          ),
        },
      });
      setReport(created);
      setRuns((current) => [
        {
          id: created.id,
          engine: created.configuration.engineId,
          provider: created.configuration.providerId,
          model: created.configuration.modelId,
          status: created.status,
          passed: created.passed,
          completedAt: created.completedAt,
          caseCount: created.summary.total,
          passedCaseCount: created.summary.passed,
          failedCaseCount: created.summary.failed,
          costUsd: created.summary.totalCostUsd,
          totalLatencyMs: created.summary.totalLatencyMs,
        },
        ...current.filter(({ id }) => id !== created.id),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Evaluation run failed");
    } finally {
      setRunning(false);
    }
  };

  const compare = async (cursor?: string) => {
    if (!baseline || !candidate || baseline === candidate) {
      setError("Choose two different evaluation runs.");
      return;
    }
    setError(null);
    try {
      const page = await api.evaluationRuns.compare(baseline, candidate, {
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      setComparison((current) =>
        cursor && current ? { ...page, rows: [...current.rows, ...page.rows] } : page
      );
      setComparisonCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not compare evaluation runs");
    }
  };

  return (
    <div className="grid min-h-[calc(100vh-12rem)] gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="space-y-3 border-r border-border/40 pr-3">
        <section className="rounded-lg border border-border/40 p-3">
          <h3 className="text-xs font-semibold">Run dataset</h3>
          <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
            {cases.map((entry) => (
              <label key={entry.id} className="flex gap-2 text-[10px]">
                <input
                  type="checkbox"
                  checked={selectedCases.includes(entry.id)}
                  onChange={() =>
                    setSelectedCases((current) =>
                      current.includes(entry.id)
                        ? current.filter((id) => id !== entry.id)
                        : [...current, entry.id]
                    )
                  }
                />
                <span className="truncate">
                  {entry.document.name} · r{entry.revision}
                </span>
              </label>
            ))}
            {!cases.length && <p className="text-[10px] text-muted-foreground">No saved cases.</p>}
          </div>
          {caseCursor && (
            <button
              onClick={() => void loadCases(caseCursor)}
              className="mt-2 w-full rounded border px-2 py-1 text-[10px]"
            >
              Load more cases
            </button>
          )}
          <select
            aria-label="Provider ID"
            value={providerId}
            onChange={(event) =>
              setProviderId(
                event.target.value as EvaluationRunReport["configuration"]["providerId"]
              )
            }
            className="mt-2 w-full rounded border bg-background px-2 py-1 text-xs"
          >
            {EVALUATION_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
          <input
            aria-label="Model ID"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="Model ID"
            className="mt-2 w-full rounded border bg-background px-2 py-1 text-xs"
          />
          <textarea
            aria-label="Evaluation prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="mt-2 h-20 w-full rounded border bg-background px-2 py-1 text-xs"
          />
          {toolNames.length > 0 && (
            <fieldset className="mt-2 space-y-1 rounded border border-border/40 p-2">
              <legend className="px-1 text-[9px] text-muted-foreground">
                Simulated tool effects
              </legend>
              {toolNames.map((name) => (
                <label key={name} className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="truncate" title={name}>
                    {name}
                  </span>
                  <select
                    aria-label={`${name} effect`}
                    value={readTools.includes(name) ? "read" : "write"}
                    onChange={(event) =>
                      setReadTools((current) =>
                        event.target.value === "read"
                          ? [...new Set([...current, name])]
                          : current.filter((entry) => entry !== name)
                      )
                    }
                    className="rounded border bg-background px-1 py-0.5 text-[9px]"
                  >
                    <option value="write">write · deny</option>
                    <option value="read">read · approve</option>
                  </select>
                </label>
              ))}
              <p className="text-[9px] text-muted-foreground">
                Tools default to write/deny; mark a tool read-only to auto-approve its fixture.
              </p>
            </fieldset>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              aria-label="Maximum cost per case"
              value={maxCost}
              onChange={(event) => setMaxCost(event.target.value)}
              placeholder="Max USD"
              inputMode="decimal"
              className="rounded border bg-background px-2 py-1 text-xs"
            />
            <input
              aria-label="Maximum latency per case"
              value={maxLatency}
              onChange={(event) => setMaxLatency(event.target.value)}
              placeholder="Max ms"
              inputMode="numeric"
              className="rounded border bg-background px-2 py-1 text-xs"
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              aria-label="Input price per million tokens"
              value={inputPrice}
              onChange={(event) => setInputPrice(event.target.value)}
              placeholder="Input $/1M"
              inputMode="decimal"
              className="rounded border bg-background px-2 py-1 text-xs"
            />
            <input
              aria-label="Output price per million tokens"
              value={outputPrice}
              onChange={(event) => setOutputPrice(event.target.value)}
              placeholder="Output $/1M"
              inputMode="decimal"
              className="rounded border bg-background px-2 py-1 text-xs"
            />
          </div>
          <button
            onClick={() => void run()}
            disabled={running}
            className="mt-2 w-full rounded bg-primary px-2 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
          >
            {running ? "Running in isolated sidecar…" : "Run evaluation"}
          </button>
        </section>

        <button
          onClick={() => void loadRuns()}
          className="w-full rounded border px-2 py-1 text-[10px]"
        >
          Refresh reports
        </button>
        {runs.map((entry) => (
          <button
            key={entry.id}
            onClick={() =>
              void api.evaluationRuns
                .get(entry.id)
                .then(setReport)
                .catch((reason) => setError(reason.message))
            }
            className="w-full rounded-lg border border-border/40 p-2 text-left hover:bg-muted"
          >
            <span className="block truncate text-[11px] font-medium">
              {entry.provider}/{entry.model}
            </span>
            <span
              className={entry.passed ? "text-[9px] text-emerald-400" : "text-[9px] text-rose-400"}
            >
              {entry.passedCaseCount}/{entry.caseCount} passed · {timestamp(entry.completedAt)}
            </span>
          </button>
        ))}
        {nextCursor && (
          <button
            onClick={() => void loadRuns(nextCursor)}
            className="w-full rounded border px-2 py-1 text-[10px]"
          >
            Load more
          </button>
        )}
      </aside>

      <main className="min-w-0 space-y-4">
        {error && (
          <p
            role="alert"
            className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-200"
          >
            {error}
          </p>
        )}
        {loading && !runs.length && (
          <p className="py-12 text-center text-xs text-muted-foreground">
            Loading evaluation reports…
          </p>
        )}
        {!loading && !report && !error && (
          <EmptyState
            title="No evaluation reports"
            description="Save an execution as a case, select it, and run an isolated regression."
          />
        )}
        {report && (
          <section className="space-y-3">
            <header className="rounded-lg border border-border/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  {report.configuration.providerId}/{report.configuration.modelId}
                </h2>
                <span
                  className={report.passed ? "text-xs text-emerald-400" : "text-xs text-rose-400"}
                >
                  {report.passed ? "PASSED" : "FAILED"}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {report.summary.passed}/{report.summary.total} cases ·{" "}
                {money(report.summary.totalCostUsd)} · {report.summary.totalLatencyMs} ms · config{" "}
                {report.configurationHash.slice(0, 10)}
              </p>
            </header>
            {report.cases.map((entry) => (
              <article key={entry.position} className="rounded-lg border border-border/40 p-3">
                <div className="flex justify-between gap-2">
                  <h3 className="text-xs font-medium">{entry.snapshot.document.name}</h3>
                  <span
                    className={
                      entry.passed ? "text-[10px] text-emerald-400" : "text-[10px] text-rose-400"
                    }
                  >
                    {entry.passed ? "passed" : "failed"}
                  </span>
                </div>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px]">
                  {JSON.stringify(entry.observation.output ?? entry.observation.error, null, 2)}
                </pre>
                <ul className="mt-2 space-y-1">
                  {entry.assertions.map((assertion, index) => (
                    <li key={`${assertion.kind}-${index}`} className="flex gap-2 text-[10px]">
                      <span
                        className={
                          assertion.status === "passed" ? "text-emerald-400" : "text-rose-400"
                        }
                      >
                        {assertion.status}
                      </span>
                      <span>
                        {assertion.kind} · {assertion.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        )}

        {runs.length >= 2 && (
          <section className="rounded-lg border border-border/40 p-3">
            <h3 className="text-xs font-semibold">Compare configurations</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {[baseline, candidate].map((value, index) => (
                <select
                  key={index}
                  aria-label={index ? "Candidate run" : "Baseline run"}
                  value={value}
                  onChange={(event) =>
                    index ? setCandidate(event.target.value) : setBaseline(event.target.value)
                  }
                  className="rounded border bg-background px-2 py-1 text-xs"
                >
                  <option value="">{index ? "Candidate" : "Baseline"}</option>
                  {runs.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.provider}/{entry.model} · {entry.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              ))}
              <button onClick={() => void compare()} className="rounded border px-2 py-1 text-xs">
                Compare
              </button>
            </div>
            {comparison && (
              <div className="mt-3 text-[10px]">
                <p>
                  {comparison.regressions} regressions · {comparison.improvements} improvements
                </p>
                {comparison.rows.map((row) => (
                  <p key={row.position} className="mt-1">
                    {row.classification} · {row.caseName} · Δ {row.latencyDeltaMs ?? "?"} ms
                  </p>
                ))}
                {comparisonCursor && (
                  <button
                    onClick={() => void compare(comparisonCursor)}
                    className="mt-2 rounded border px-2 py-1 text-[10px]"
                  >
                    Load more comparison rows
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
