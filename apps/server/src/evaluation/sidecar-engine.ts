import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type LanguageModel } from "ai";
import { redactTrajectoryText, type EvaluationObservation } from "@chvor/shared";
import { z } from "zod";
import { evaluationMessages } from "./evaluation-input.ts";
import type {
  EvaluationSidecarCaseResult,
  EvaluationSidecarRequest,
  EvaluationSidecarResponse,
} from "./sidecar-protocol.ts";

function loopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

function checkedBaseUrl(value: string, localOnly: boolean): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url))) {
    throw new Error("evaluation model base URL must use HTTPS or loopback HTTP");
  }
  if (localOnly && !loopback(url))
    throw new Error("local evaluation providers require a loopback URL");
  return url.toString().replace(/\/$/, "");
}

function createSidecarModel(request: EvaluationSidecarRequest): LanguageModel {
  const { providerId, modelId } = request.configuration;
  const { apiKey, baseUrl } = request.credential;
  switch (providerId) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId, { structuredOutputs: false });
    case "deepseek":
      return createOpenAI({ apiKey, baseURL: "https://api.deepseek.com" })(modelId);
    case "minimax":
      return createOpenAI({ apiKey, baseURL: "https://api.minimax.io/v1" })(modelId);
    case "openrouter":
      return createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" })(modelId);
    case "groq":
      return createOpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" })(modelId);
    case "mistral":
      return createOpenAI({ apiKey, baseURL: "https://api.mistral.ai/v1" })(modelId);
    case "ollama-cloud":
      return createOpenAI({ apiKey, baseURL: "https://ollama.com/v1" })(modelId);
    case "ollama":
      return createOpenAI({
        apiKey: apiKey || "ollama",
        baseURL: checkedBaseUrl(baseUrl || "http://localhost:11434/v1", true),
      })(modelId);
    case "lmstudio":
      return createOpenAI({
        apiKey: apiKey || "lmstudio",
        baseURL: checkedBaseUrl(baseUrl || "http://localhost:1234/v1", true),
      })(modelId);
    case "vllm":
      return createOpenAI({
        apiKey: apiKey || "vllm",
        baseURL: checkedBaseUrl(baseUrl || "http://localhost:8000/v1", true),
      })(modelId);
    default:
      throw new Error(`unsupported evaluation provider: ${providerId}`);
  }
}

function credentialToProtect(request: EvaluationSidecarRequest): string {
  const { providerId } = request.configuration;
  const { apiKey } = request.credential;
  const localProviderPlaceholder =
    (providerId === "ollama" || providerId === "lmstudio" || providerId === "vllm") &&
    apiKey === providerId;
  return localProviderPlaceholder ? "" : apiKey;
}

function redactSidecarText(value: string, apiKey: string): string {
  const withoutCredential = apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  return redactTrajectoryText(withoutCredential);
}

function secretLike(value: string, apiKey: string): boolean {
  return (Boolean(apiKey) && value.includes(apiKey)) || redactTrajectoryText(value) !== value;
}

function cost(
  usage: EvaluationObservation["usage"],
  pricing: EvaluationSidecarRequest["configuration"]["pricing"]
): number | null {
  if (!usage || !pricing) return null;
  return (
    (usage.inputTokens * pricing.inputUsdPerMillion +
      usage.outputTokens * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

async function runCase(
  request: EvaluationSidecarRequest,
  position: number,
  modelFactory: (request: EvaluationSidecarRequest) => LanguageModel
): Promise<EvaluationSidecarCaseResult> {
  const snapshot = request.cases[position];
  const protectedCredential = credentialToProtect(request);
  const started = performance.now();
  const calls: EvaluationObservation["toolCalls"] = [];
  let detected = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.configuration.caseTimeoutMs);
  timeout.unref?.();
  try {
    const tools = Object.fromEntries(
      request.configuration.tools.map((stub) => [
        stub.name,
        tool({
          description: stub.description,
          parameters: z.object({}).passthrough(),
          execute: async (args) => {
            detected ||= secretLike(JSON.stringify(args), protectedCredential);
            const approved = stub.approval === "auto-approve";
            calls.push({
              name: stub.name,
              approvalRequested: true,
              approved,
              executed: approved,
            });
            return approved
              ? stub.result
              : { error: "Denied by deterministic evaluation approval policy" };
          },
        }),
      ])
    );
    const generated = await generateText({
      model: modelFactory(request),
      system: request.configuration.prompt,
      messages: evaluationMessages(snapshot.document),
      temperature: request.configuration.temperature,
      maxSteps: request.configuration.maxRounds,
      ...(Object.keys(tools).length ? { tools } : {}),
      abortSignal: controller.signal,
    });
    detected ||= secretLike(generated.text, protectedCredential);
    const usage = {
      inputTokens: generated.usage.promptTokens,
      outputTokens: generated.usage.completionTokens,
      totalTokens: generated.usage.totalTokens,
    };
    const status =
      generated.finishReason === "stop"
        ? "completed"
        : generated.finishReason === "length" || generated.finishReason === "tool-calls"
          ? "round-limited"
          : "failed";
    const terminalError =
      status === "failed" ? `model finished with ${generated.finishReason}` : null;
    return {
      secretDetected: detected,
      observation: {
        status,
        output: redactSidecarText(generated.text, protectedCredential),
        toolCalls: calls,
        usage,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        costUsd: cost(usage, request.configuration.pricing),
        error: terminalError,
      },
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    const rawError = error instanceof Error ? error.message : String(error);
    detected ||= secretLike(rawError, protectedCredential);
    const safeError = redactSidecarText(rawError, protectedCredential).slice(0, 4_000);
    return {
      secretDetected: detected,
      observation: {
        status: aborted ? "aborted" : "failed",
        toolCalls: calls,
        usage: null,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        costUsd: null,
        error: safeError,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runEvaluationSidecar(
  request: EvaluationSidecarRequest,
  modelFactory = createSidecarModel
): Promise<EvaluationSidecarResponse> {
  const cases: EvaluationSidecarCaseResult[] = [];
  for (let position = 0; position < request.cases.length; position += 1) {
    cases.push(await runCase(request, position, modelFactory));
  }
  return { cases };
}
