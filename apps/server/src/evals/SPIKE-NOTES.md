# Eval Harness Spike — Notes

Outcome of the 1-day spike: **skip `@mastra/evals`, keep three local LLM-judge scorers**. Mastra's non-eval primitives overlap entirely with chvor's existing stack (orchestrator, memory graph, MCP manager, llm-router), and the eval scorers themselves are thin prompt wrappers that reimplement in ~30 lines each. Adopting the package pinned us to someone else's prompt changes and a transitive tree we don't need.

## What this spike builds

- `fixtures.ts` — 10 positive + 2 negative cases across 5 categories (tool-required, tool-not-required, memory-recall, tone, refusal).
- `scorers/tool-use.ts` — rule-based, deterministic. No LLM, runs anywhere.
- `scorers/llm-judge.ts` — env-driven model factory (ANTHROPIC_API_KEY or OPENAI_API_KEY + optional EVAL_MODEL override), uses Vercel AI SDK `generateObject` with a zod schema.
- `scorers/answer-relevancy.ts`, `scorers/toxicity.ts`, `scorers/faithfulness.ts` — three LLM-judge scorers. Prompts are local, versioned with the rest of the codebase, easy to tune.
- `run-eval.ts` — harness. Rule-based always runs; LLM scorers run automatically when an API key is in env. Writes per-run JSON to `apps/server/evals-results/`.
- `__tests__/smoke.eval.test.ts` — Vitest gated by `EVAL=1`. Asserts positive/negative discrimination.

## What this spike deliberately does NOT build

- **No live orchestrator invocation.** `executeConversation()` bootstraps credentials, MCP, memory graph, skills, and the DB. Fixtures carry pre-captured / hand-crafted outputs. Next step if we graduate the spike: a capture hook in `apps/server/src/gateway/gateway.ts` that writes real `{input, output, toolsCalled, sessionId}` rows to JSONL we replay through this harness.
- **No Mastra.** Evaluated and dropped — see rationale below.
- **No DB-backed credential resolution.** Spike reads API keys from env to stay runnable standalone.

## How to run

Rule-based only (no network, no keys needed):

```bash
cd apps/server
EVAL=1 node --experimental-strip-types src/evals/run-eval.ts
```

Full run with LLM scorers:

```bash
cd apps/server
ANTHROPIC_API_KEY=... EVAL=1 pnpm test:evals
# or
OPENAI_API_KEY=... EVAL_MODEL=gpt-4o-mini EVAL=1 pnpm test:evals
```

Results land in `apps/server/evals-results/<timestamp>.json` (gitignored).

## Why we dropped `@mastra/evals`

1. **Mastra's agent/workflow/memory/RAG primitives all overlap with chvor's existing stack.** Adopting Mastra as a framework would be a rewrite with no gain. Only the evals slice had a real gap.
2. **The eval scorers are thin prompt wrappers.** Each is ~30 lines of prompt + a zod schema. Vendoring them means we own the prompts, version them alongside chvor, and can tune them for chvor-specific concerns (tone, memory recall, emotion).
3. **Zero new dep weight.** We already ship `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, and `zod` transitively. No `@mastra/*` in the tree.
4. **Output shape matches Brain Canvas natively.** No adapter layer between scorer results and how chvor displays them.

## Verified

- Rule-based path runs end-to-end via `node --experimental-strip-types`: 10 positive fixtures score 1.00, 2 negative fixtures score 0.75, average 0.958.
- Negative fixtures confirm the scorer can discriminate — it's not rubber-stamping.
- No dependency install was required to validate the harness shape.

## Follow-ups if we graduate the spike

1. **Gateway capture hook** → JSONL of real orchestrator turns, replayed through this harness.
2. **Grow fixtures** from 10 → curated regression set of ~50 drawn from captures.
3. **chvor-specific scorers**: emotional appropriateness (reuse `emotion-engine.ts` valence), memory-recall correctness against the memory graph, refusal calibration.
4. **Wire as a release gate**, not a per-PR gate. LLM-judged evals are too slow + costly for every PR; run them before cutting a release.
5. **Swap `llm-judge.ts` for `createModelForRole("judge")`** once we add a dedicated role config — removes the env-var shortcut.
