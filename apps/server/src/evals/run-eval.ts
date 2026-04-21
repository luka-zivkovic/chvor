import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures, type EvalFixture } from "./fixtures.ts";
import { scoreToolUse, type ToolUseScoreResult } from "./scorers/tool-use.ts";

interface LlmScore {
  score: number;
  reason: string;
  latencyMs?: number;
  error?: string;
}

interface CaseResult {
  id: string;
  category: EvalFixture["category"];
  toolUse: ToolUseScoreResult;
  answerRelevancy?: LlmScore;
  toxicity?: LlmScore;
  faithfulness?: LlmScore;
}

interface AggregateResult {
  timestamp: string;
  llmEnabled: boolean;
  cases: CaseResult[];
  averages: {
    toolUse: number;
    answerRelevancy?: number;
    toxicity?: number;
    faithfulness?: number;
  };
}

async function safeScore<T extends LlmScore>(fn: () => Promise<T>): Promise<LlmScore> {
  try {
    return await fn();
  } catch (err) {
    return { score: NaN, reason: "", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runEval(): Promise<AggregateResult> {
  // LLM scorers are opt-in: they cost money + network. Rule-based always runs.
  const llmEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  if (!llmEnabled) {
    console.warn("[evals] No ANTHROPIC_API_KEY or OPENAI_API_KEY — running rule-based scorer only.");
  }

  const cases: CaseResult[] = [];

  for (const fixture of fixtures) {
    const toolUse = scoreToolUse(fixture, fixture.output);

    const result: CaseResult = { id: fixture.id, category: fixture.category, toolUse };

    if (llmEnabled) {
      // Lazy-import so the rule-based path runs on a cold checkout (no node_modules).
      const [{ scoreAnswerRelevancy }, { scoreToxicity }, { scoreFaithfulness }] = await Promise.all([
        import("./scorers/answer-relevancy.ts"),
        import("./scorers/toxicity.ts"),
        import("./scorers/faithfulness.ts"),
      ]);
      const [relevancy, toxicity, faithfulness] = await Promise.all([
        safeScore(() => scoreAnswerRelevancy({ input: fixture.input, output: fixture.output })),
        safeScore(() => scoreToxicity({ output: fixture.output })),
        safeScore(() =>
          scoreFaithfulness({
            input: fixture.input,
            output: fixture.output,
            toolsCalled: fixture.toolsCalled,
          }),
        ),
      ]);
      result.answerRelevancy = relevancy;
      result.toxicity = toxicity;
      result.faithfulness = faithfulness;
    }

    cases.push(result);
  }

  const averages: AggregateResult["averages"] = { toolUse: avg(cases.map((c) => c.toolUse.score)) };
  if (llmEnabled) {
    averages.answerRelevancy = avgScores(cases.map((c) => c.answerRelevancy));
    averages.toxicity = avgScores(cases.map((c) => c.toxicity));
    averages.faithfulness = avgScores(cases.map((c) => c.faithfulness));
  }

  const result: AggregateResult = {
    timestamp: new Date().toISOString(),
    llmEnabled,
    cases,
    averages,
  };

  // Anchor output to apps/server/ regardless of cwd so `.gitignore` always catches it.
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evals-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${result.timestamp.replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[evals] wrote ${outPath}`);

  printTable(result);
  return result;
}

function avg(nums: number[]): number {
  if (!nums.length) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function avgScores(scores: Array<LlmScore | undefined>): number {
  const nums = scores
    .map((s) => s?.score)
    .filter((n): n is number => typeof n === "number" && !Number.isNaN(n));
  return nums.length ? avg(nums) : NaN;
}

function printTable(result: AggregateResult): void {
  const rows = result.cases.map((c) => {
    const row: Record<string, string | number> = {
      id: c.id,
      category: c.category,
      toolUse: c.toolUse.score.toFixed(2),
    };
    if (result.llmEnabled) {
      row.relevancy = fmt(c.answerRelevancy);
      row.toxicity = fmt(c.toxicity);
      row.faithful = fmt(c.faithfulness);
    }
    return row;
  });
  console.table(rows);
  console.log("[evals] averages:", result.averages);
}

function fmt(s?: LlmScore): string {
  if (!s) return "-";
  if (s.error) return `err:${s.error.slice(0, 18)}`;
  return Number.isNaN(s.score) ? "nan" : s.score.toFixed(2);
}

// Allow `node --experimental-strip-types src/evals/run-eval.ts` ad-hoc invocation.
if (import.meta.url === `file://${process.argv[1]}`) {
  runEval().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
