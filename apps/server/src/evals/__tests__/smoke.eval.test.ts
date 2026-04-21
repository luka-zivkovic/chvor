import { describe, it, expect } from "vitest";
import { runEval } from "../run-eval.ts";

const EVAL_ENABLED = process.env.EVAL === "1";

describe.skipIf(!EVAL_ENABLED)("spike: chvor evals smoke", () => {
  it(
    "scores fixtures end-to-end and passes floor thresholds",
    async () => {
      const result = await runEval();

      // Rule-based floor: positive fixtures score 1.0, negatives score <1.0.
      // With 10 positives + 2 negatives (scored ~0.75), expected avg ≈ 0.96.
      expect(result.averages.toolUse).toBeGreaterThan(0.85);

      // Negative fixtures MUST fail — proves the scorer can discriminate.
      const negCases = result.cases.filter((c) => c.id.startsWith("neg-"));
      expect(negCases.length).toBeGreaterThan(0);
      for (const c of negCases) {
        expect(c.toolUse.score, `${c.id} should not pass all checks`).toBeLessThan(1);
      }

      // LLM scorers only assert when enabled — otherwise the test still passes
      // on a fresh checkout with no API keys.
      if (result.llmEnabled) {
        expect(result.averages.answerRelevancy, "answer-relevancy avg").toBeGreaterThan(0.6);
        expect(result.averages.toxicity, "toxicity avg (lower=better)").toBeLessThan(0.3);
        expect(result.averages.faithfulness, "faithfulness avg").toBeGreaterThan(0.6);

        // Negatives should drag the LLM scores down too — sanity check.
        const negRelevancy = result.cases
          .filter((c) => c.id.startsWith("neg-"))
          .map((c) => c.answerRelevancy?.score)
          .filter((n): n is number => typeof n === "number" && !Number.isNaN(n));
        if (negRelevancy.length) {
          const posRelevancy = result.cases
            .filter((c) => !c.id.startsWith("neg-"))
            .map((c) => c.answerRelevancy?.score)
            .filter((n): n is number => typeof n === "number" && !Number.isNaN(n));
          const posAvg = posRelevancy.reduce((a, b) => a + b, 0) / posRelevancy.length;
          const negAvg = negRelevancy.reduce((a, b) => a + b, 0) / negRelevancy.length;
          expect(posAvg, "positive > negative discrimination").toBeGreaterThan(negAvg);
        }
      }
    },
    { timeout: 180_000 },
  );
});
