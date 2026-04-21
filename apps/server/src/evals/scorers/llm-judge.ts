import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import type { z } from "zod";

/**
 * Minimal env-driven model factory for the eval harness.
 *
 * Deliberately bypasses chvor's `llm-router.ts` + credential DB — the spike
 * runs standalone via `node --experimental-strip-types` and mustn't require
 * booting the server. If the spike graduates to a real feature, swap this for
 * `createModelForRole("judge")` and add a dedicated role config.
 */
function createJudgeModel() {
  const model = process.env.EVAL_MODEL ?? "claude-3-5-sonnet-latest";

  if (model.startsWith("gpt-") || model.startsWith("openai/")) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    return createOpenAI({ apiKey })(model.replace(/^openai\//, ""));
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set (or set EVAL_MODEL to an OpenAI model)");
  return createAnthropic({ apiKey })(model.replace(/^anthropic\//, ""));
}

export interface JudgeResult<T> {
  value: T;
  latencyMs: number;
}

export async function judge<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}): Promise<JudgeResult<T>> {
  const model = createJudgeModel();
  const start = Date.now();
  const { object } = await generateObject({
    model,
    system: opts.system,
    prompt: opts.user,
    schema: opts.schema,
  });
  return { value: object, latencyMs: Date.now() - start };
}
