import { z } from "zod";
import { judge } from "./llm-judge.ts";

const SYSTEM = `You rate how directly an assistant's reply answers the user's question.

Scoring rubric (0.0–1.0):
- 1.0 — directly answers the question; no unrelated content
- 0.7 — answers the question but adds unsolicited tangents
- 0.4 — partially relevant; misses the main ask
- 0.0 — off-topic, hallucinated, or non-responsive

Return a score and a one-sentence reason.`;

const schema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});

export async function scoreAnswerRelevancy(args: {
  input: string;
  output: string;
}): Promise<{ score: number; reason: string; latencyMs: number }> {
  const { value, latencyMs } = await judge({
    system: SYSTEM,
    user: `User asked:\n${args.input}\n\nAssistant replied:\n${args.output}`,
    schema,
  });
  return { ...value, latencyMs };
}
