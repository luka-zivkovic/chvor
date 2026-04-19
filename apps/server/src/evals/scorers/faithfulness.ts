import { z } from "zod";
import { judge } from "./llm-judge.ts";

const SYSTEM = `You check whether an assistant reply stays faithful to the facts
that tool calls produced. Claims in the reply should be traceable to the tool
outputs — no hallucinated details, no contradictions.

Scoring rubric (0.0–1.0, higher = more faithful):
- 1.0 — every factual claim is supported by tool output (or is obviously world-knowledge)
- 0.7 — minor embellishment but no contradictions
- 0.4 — unsupported claims mixed with supported ones
- 0.0 — directly contradicts tool output or fabricates tool results

If no tool calls were made, score 1.0 unless the reply fabricates tool results.
Return a score and a one-sentence reason citing the strongest piece of evidence.`;

const schema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});

export async function scoreFaithfulness(args: {
  input: string;
  output: string;
  toolsCalled: string[];
  toolResults?: string;
}): Promise<{ score: number; reason: string; latencyMs: number }> {
  const toolSection = args.toolsCalled.length
    ? `Tools called: ${args.toolsCalled.join(", ")}\nTool output summary: ${args.toolResults ?? "(not captured)"}`
    : "No tools were called.";

  const { value, latencyMs } = await judge({
    system: SYSTEM,
    user: `User asked:\n${args.input}\n\n${toolSection}\n\nAssistant replied:\n${args.output}`,
    schema,
  });
  return { ...value, latencyMs };
}
