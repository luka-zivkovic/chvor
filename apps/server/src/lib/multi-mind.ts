import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import type { ExecutionEvent, MultiMindInsight, MultiMindRole } from "@chvor/shared";
import { createModel, resolveRoleConfig } from "./llm-router.ts";
import { appendCognitiveLoopEvent } from "./cognitive-loop.ts";

const ROLES: Array<{ role: MultiMindRole; title: string; system: string }> = [
  {
    role: "researcher",
    title: "Researcher",
    system: "You are the researcher mind. Surface missing facts, relevant context, and what should be checked. Be concrete. Do not answer the user; produce terse bullets for the main agent.",
  },
  {
    role: "planner",
    title: "Planner",
    system: "You are the planner mind. Propose the safest execution plan, sequencing, and tool-use strategy. Do not answer the user; produce terse bullets for the main agent.",
  },
  {
    role: "critic",
    title: "Critic",
    system: "You are the critic mind. Look for risks, hidden assumptions, failure modes, and better alternatives. Do not answer the user; produce terse bullets for the main agent.",
  },
];

const MULTI_MIND_TIMEOUT_MS = 20_000;

export interface MultiMindResult {
  insights: MultiMindInsight[];
  digest: string;
}

export interface MultiMindOptions {
  userText: string;
  memoryFacts: string[];
  channelType?: string;
  loopId?: string;
  abortSignal?: AbortSignal;
  emit: (event: ExecutionEvent) => void;
}

function shouldRunMultiMind(opts: MultiMindOptions): boolean {
  if (process.env.CHVOR_MULTI_MIND === "0") return false;
  if (opts.channelType === "daemon") return true;
  const text = opts.userText.trim();
  if (text.length > 220) return true;
  return /\b(plan|analy[sz]e|architect|design|debug|diagnose|investigate|build|implement|refactor|compare|strategy|next\s*gen|parallel|agent)\b/i.test(text);
}

function signalWithTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MULTI_MIND_TIMEOUT_MS);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal;
}

function buildUserPrompt(opts: MultiMindOptions): string {
  const memoryBlock = opts.memoryFacts.length > 0
    ? `\n\nRelevant memory facts:\n${opts.memoryFacts.slice(0, 12).map((m) => `- ${m}`).join("\n")}`
    : "";
  return `User request:\n${opts.userText.slice(0, 5000)}${memoryBlock}\n\nReturn 3-5 short bullets. No preamble.`;
}

function titleFromText(text: string): string {
  const first = text.split(/\n+/).find((line) => line.trim()) ?? text;
  return first.replace(/^[-*\d.\s]+/, "").trim().slice(0, 90) || "Insight";
}

export async function runParallelMultiMind(opts: MultiMindOptions): Promise<MultiMindResult> {
  if (!shouldRunMultiMind(opts)) return { insights: [], digest: "" };

  let model;
  try {
    model = createModel(resolveRoleConfig("lightweight"));
  } catch (err) {
    console.warn("[multi-mind] skipped — lightweight model unavailable:", err instanceof Error ? err.message : String(err));
    return { insights: [], digest: "" };
  }

  const startedAt = Date.now();
  opts.emit({ type: "brain.thinking", data: { thought: "Spawning parallel minds…" } });
  opts.emit({ type: "multi_mind.started", data: { roles: ROLES.map((r) => r.role) } });
  const userPrompt = buildUserPrompt(opts);
  const signal = signalWithTimeout(opts.abortSignal);

  const tasks = ROLES.map(async ({ role, title, system }) => {
    const agentId = randomUUID();
    const agentStartedAt = Date.now();
    opts.emit({ type: "multi_mind.agent.started", data: { agentId, role, title } });
    try {
      const result = await generateText({
        model,
        system,
        messages: [{ role: "user", content: userPrompt }],
        maxSteps: 1,
        maxTokens: 260,
        abortSignal: signal,
      });
      const text = result.text.trim();
      const insight: MultiMindInsight = {
        agentId,
        role,
        title: titleFromText(text),
        text,
        durationMs: Date.now() - agentStartedAt,
      };
      opts.emit({ type: "multi_mind.agent.completed", data: insight });
      return insight;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      opts.emit({ type: "multi_mind.agent.failed", data: { agentId, role, title, error } });
      return null;
    }
  });

  const insights = (await Promise.all(tasks)).filter(Boolean) as MultiMindInsight[];
  opts.emit({ type: "multi_mind.completed", data: { insights, durationMs: Date.now() - startedAt } });

  const digest = insights.length > 0
    ? `Parallel mind notes (advisory):\n${insights.map((i) => `[${i.role}] ${i.text}`).join("\n\n")}`
    : "";

  if (opts.loopId && digest) {
    appendCognitiveLoopEvent(opts.loopId, "memory.insight.created", "Parallel minds completed", digest.slice(0, 1500), {
      roles: insights.map((i) => i.role),
      durationMs: Date.now() - startedAt,
    });
  }

  return { insights, digest };
}
