import { readFileSync } from "node:fs";
import { createServerApi, type ServerApiOptions } from "../lib/server-api.js";

export interface EvalIo {
  out: (value: string) => void;
  error: (value: string) => void;
  readFile: (path: string) => string;
}

const defaultIo: EvalIo = {
  out: (value) => process.stdout.write(`${value}\n`),
  error: (value) => process.stderr.write(`${value}\n`),
  readFile: (path) => readFileSync(path, "utf8"),
};

export interface EvalRunOptions extends ServerApiOptions {
  cases?: string[];
  provider: string;
  model: string;
  prompt: string;
  toolStubs?: string;
  maxCost?: string;
  inputPrice?: string;
  outputPrice?: string;
  maxLatency?: string;
  json?: boolean;
}

function failureCode(error: unknown): number {
  if (error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted")))
    return 130;
  return 2;
}

export async function runEvaluationCommand(
  files: string[],
  options: EvalRunOptions,
  io: EvalIo = defaultIo
): Promise<number> {
  try {
    const api = createServerApi(options);
    const selections = [...(options.cases ?? []).map((id) => ({ id, critical: true }))];
    for (const file of files) {
      const imported = await api.importCase(JSON.parse(io.readFile(file)) as unknown);
      selections.push({ id: imported.id, critical: true });
    }
    if (!selections.length) throw new Error("provide at least one case ID or case file");
    if (options.maxCost && (!options.inputPrice || !options.outputPrice)) {
      throw new Error("--max-cost requires --input-price and --output-price");
    }
    if (Boolean(options.inputPrice) !== Boolean(options.outputPrice)) {
      throw new Error("input and output pricing must be supplied together");
    }
    const tools = options.toolStubs
      ? (JSON.parse(io.readFile(options.toolStubs)) as unknown[])
      : [];
    const report = await api.runEvaluation({
      cases: selections,
      configuration: {
        engineId: "chvor-isolated-v1",
        providerId: options.provider,
        modelId: options.model,
        prompt: options.prompt,
        temperature: 0,
        maxRounds: 4,
        caseTimeoutMs: 120_000,
        limits: {
          ...(options.maxCost ? { maxCostUsdPerCase: Number(options.maxCost) } : {}),
          ...(options.maxLatency ? { maxLatencyMsPerCase: Number(options.maxLatency) } : {}),
        },
        ...(options.inputPrice && options.outputPrice
          ? {
              pricing: {
                inputUsdPerMillion: Number(options.inputPrice),
                outputUsdPerMillion: Number(options.outputPrice),
              },
            }
          : {}),
        tools,
      },
    });
    if (options.json) io.out(JSON.stringify(report));
    else {
      io.out(`Evaluation ${report.id}: ${report.summary.passed}/${report.summary.total} passed`);
      for (const result of report.cases) {
        io.out(`${result.passed ? "PASS" : "FAIL"}  ${result.snapshot.document.name}`);
      }
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return failureCode(error);
  }
}

export async function compareEvaluationCommand(
  baseline: string,
  candidate: string,
  options: ServerApiOptions & { json?: boolean },
  io: EvalIo = defaultIo
): Promise<number> {
  try {
    const comparison = await createServerApi(options).compareEvaluations(baseline, candidate);
    if (options.json) io.out(JSON.stringify(comparison));
    else {
      io.out(`${comparison.regressions} regressions, ${comparison.improvements} improvements`);
      for (const row of comparison.rows) io.out(`${row.classification}  ${row.caseName}`);
    }
    return comparison.regressions > 0 ? 1 : 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return failureCode(error);
  }
}
