import {
  assembleContext,
  contextPromptOverheadTokens,
  type ContextAssemblyCandidate,
  type ContextAssemblyResult,
  type ContextLayerCaps,
} from "@chvor/shared";
import { zodSchema } from "ai";
import { createContextTokenizer } from "./context-tokenizer.ts";

export const CONTEXT_ASSEMBLY_SCORING = {
  id: "chvor-context-canonical",
  version: "1",
  precision: 6,
} as const;

export const CONTEXT_LAYER_ALLOCATION = {
  identity: 20,
  human: 20,
  working: 25,
  procedural: 15,
  episodic: 10,
  knowledge: 10,
} as const;

export class ContextWindowOverflowError extends Error {}
export class ContextStableOverflowError extends ContextWindowOverflowError {}
export class ContextStableSourceError extends Error {}

export interface ContextBudgetProfile {
  contextWindowTokens: number;
  responseReserveTokens: number;
}

/** Pick the fallback profile with the least usable prompt headroom. */
export function selectConservativeContextProfile<T extends ContextBudgetProfile>(
  profiles: readonly T[]
): T {
  if (profiles.length === 0)
    throw new RangeError("at least one context budget profile is required");
  return profiles.reduce((smallest, candidate) => {
    const candidateHeadroom = candidate.contextWindowTokens - candidate.responseReserveTokens;
    const smallestHeadroom = smallest.contextWindowTokens - smallest.responseReserveTokens;
    return candidateHeadroom < smallestHeadroom ? candidate : smallest;
  });
}

export interface ContextToolDefinition {
  description?: string;
  parameters: unknown;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

/** Project AI SDK tool objects to the schemas providers actually receive. */
export function projectToolDefinitionsForContext(
  definitions: Record<string, ContextToolDefinition>
): Array<{ name: string; description?: string; inputSchema: unknown }> {
  return Object.entries(definitions)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([name, definition]) => ({
      name,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      inputSchema: zodSchema(definition.parameters as Parameters<typeof zodSchema>[0]).jsonSchema,
    }));
}

const PROTOCOL_BASE_FRAMING_BYTES = 256;
const PROTOCOL_MESSAGE_FRAMING_BYTES = 64;
const PROTOCOL_TOOL_FRAMING_BYTES = 64;
function serializedMessagesForAccounting(messages: unknown[]): {
  contents: string[];
  binaryMediaTokens: number;
} {
  let binaryMediaTokens = 0;
  const replaceBinary = function (this: Record<string, unknown>, _key: string, value: unknown) {
    const reserve = (): number => {
      if (this.type === "image") return 1_000;
      const mimeType = typeof this.mimeType === "string" ? this.mimeType : "";
      if (mimeType.startsWith("audio/")) return 500;
      if (mimeType.startsWith("video/")) return 2_500;
      return 2_500;
    };
    if (ArrayBuffer.isView(value)) {
      binaryMediaTokens += reserve();
      return "[binary-media]";
    }
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "Buffer" &&
      Array.isArray((value as { data?: unknown }).data)
    ) {
      binaryMediaTokens += reserve();
      return "[binary-media]";
    }
    return value;
  };
  const contents = messages.map((message) => {
    if (typeof message !== "object" || message === null) {
      return JSON.stringify(message, replaceBinary) ?? "";
    }
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role === "user" && Array.isArray(content)) {
      return content
        .map((part) => {
          // Run the replacer to account binary media, but only model-visible
          // text contributes ordinary tokens for native user media parts.
          JSON.stringify(part, replaceBinary);
          return typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "";
        })
        .join("");
    }
    return typeof content === "string" ? content : (JSON.stringify(content, replaceBinary) ?? "");
  });
  return {
    contents,
    binaryMediaTokens,
  };
}

function toolDefinitionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === "object" && value !== null ? Object.keys(value).length : 0;
}

function protocolFramingTokens(messageCount: number, toolCount: number): number {
  return (
    PROTOCOL_BASE_FRAMING_BYTES +
    messageCount * PROTOCOL_MESSAGE_FRAMING_BYTES +
    toolCount * PROTOCOL_TOOL_FRAMING_BYTES
  );
}

export interface AssertContextAttemptFitsInput {
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  responseReserveTokens: number;
  messages: unknown[];
  toolDefinitions: Record<string, ContextToolDefinition>;
}

/**
 * Recheck the complete request before every model attempt. Model-visible content,
 * provider-facing tool schemas, media reserves, and fixed envelope margins cover
 * the request until provider-native request tokenizers are registered.
 */
export function assertContextAttemptFits(input: AssertContextAttemptFitsInput): void {
  const tokenizer = createContextTokenizer(input.providerId, input.modelId);
  const tools = projectToolDefinitionsForContext(input.toolDefinitions);
  const messages = serializedMessagesForAccounting(input.messages);
  const requestTokens =
    messages.contents.reduce((total, content) => total + tokenizer.countTokens(content), 0) +
    messages.binaryMediaTokens +
    tokenizer.countTokens(JSON.stringify(tools)) +
    protocolFramingTokens(input.messages.length, tools.length) +
    input.responseReserveTokens;
  if (requestTokens > input.contextWindowTokens) {
    throw new ContextWindowOverflowError(
      `model attempt requires ${requestTokens} tokens but the model window is ${input.contextWindowTokens}`
    );
  }
}

export function allocateContextLayerCaps(hierarchyBudgetTokens: number): ContextLayerCaps {
  if (!Number.isSafeInteger(hierarchyBudgetTokens) || hierarchyBudgetTokens < 0) {
    throw new RangeError("hierarchy budget must be a non-negative safe integer");
  }
  const identity = Math.floor((hierarchyBudgetTokens * CONTEXT_LAYER_ALLOCATION.identity) / 100);
  const human = Math.floor((hierarchyBudgetTokens * CONTEXT_LAYER_ALLOCATION.human) / 100);
  const working = Math.floor((hierarchyBudgetTokens * CONTEXT_LAYER_ALLOCATION.working) / 100);
  const procedural = Math.floor(
    (hierarchyBudgetTokens * CONTEXT_LAYER_ALLOCATION.procedural) / 100
  );
  const episodic = Math.floor((hierarchyBudgetTokens * CONTEXT_LAYER_ALLOCATION.episodic) / 100);
  return {
    identity,
    human,
    working,
    procedural,
    episodic,
    knowledge: hierarchyBudgetTokens - identity - human - working - procedural - episodic,
  };
}

export interface AssembleTurnContextInput {
  id: string;
  createdAt: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  responseReserveTokens: number;
  systemInstructions: string;
  currentRequest: string;
  currentRequestMediaTokens?: number;
  toolDefinitions: unknown;
  candidates: ContextAssemblyCandidate[];
}

function serializedToolDefinitions(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch (error) {
    throw new TypeError("tool definitions must be serializable for context accounting", {
      cause: error,
    });
  }
}

/** Assemble one model attempt with every outside-hierarchy input reserved first. */
export function assembleTurnContext(input: AssembleTurnContextInput): ContextAssemblyResult {
  const tokenizer = createContextTokenizer(input.providerId, input.modelId);
  const systemInstructionTokens = tokenizer.countTokens(input.systemInstructions);
  const currentRequestTokens =
    tokenizer.countTokens(input.currentRequest) + (input.currentRequestMediaTokens ?? 0);
  const toolDefinitionTokens = tokenizer.countTokens(
    serializedToolDefinitions(input.toolDefinitions)
  );
  // Initial attempt consists of two system messages, the assembled-context data
  // message, and the native current request. Later rounds are rechecked against
  // their larger message set by assertContextAttemptFits().
  const otherPromptTokens =
    contextPromptOverheadTokens(tokenizer) +
    protocolFramingTokens(4, toolDefinitionCount(input.toolDefinitions));
  const reserved =
    systemInstructionTokens +
    currentRequestTokens +
    toolDefinitionTokens +
    otherPromptTokens +
    input.responseReserveTokens;
  if (reserved > input.contextWindowTokens) {
    throw new ContextWindowOverflowError(
      `outside-hierarchy inputs require ${reserved} tokens but the model window is ${input.contextWindowTokens}`
    );
  }
  const hierarchyBudgetTokens = input.contextWindowTokens - reserved;
  const result = assembleContext(
    {
      schemaVersion: 1,
      id: input.id,
      createdAt: input.createdAt,
      configuration: {
        tokenizer: { id: tokenizer.id, version: tokenizer.version },
        retrievalScoring: {
          id: CONTEXT_ASSEMBLY_SCORING.id,
          version: CONTEXT_ASSEMBLY_SCORING.version,
        },
        contextWindowTokens: input.contextWindowTokens,
        systemInstructionTokens,
        developerInstructionTokens: 0,
        currentRequestTokens,
        otherPromptTokens,
        responseReserveTokens: input.responseReserveTokens,
        toolDefinitionTokens,
        hierarchyBudgetTokens,
      },
      layerCaps: allocateContextLayerCaps(hierarchyBudgetTokens),
      scorePrecision: CONTEXT_ASSEMBLY_SCORING.precision,
      candidates: input.candidates,
    },
    tokenizer
  );
  const critical = result.exclusions.filter(({ critical }) => critical);
  if (critical.length > 0) {
    const references = critical
      .map(({ reference }) => `${reference.namespace}:${reference.id}@${reference.revision}`)
      .join(",");
    throw new ContextStableOverflowError(
      `stable context has no approved representation within budget: ${references}`
    );
  }
  return result;
}
