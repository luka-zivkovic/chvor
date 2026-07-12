import {
  contextAssemblyCandidateSchema,
  type ChatMessage,
  type ContextAssemblyCandidate,
} from "@chvor/shared";

export interface RollingSummaryContext {
  sessionId: string;
  revision: string;
  content: string;
  eventTime: string | null;
}

export interface WorkingContextInput {
  messages: readonly ChatMessage[];
  currentRequestId: string;
  rollingSummary?: RollingSummaryContext | null;
}

export const WORKING_CONTEXT_CANDIDATE_MAX = 500;

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

function priorMessages(input: WorkingContextInput): ChatMessage[] {
  const chronological = [...input.messages].sort((left, right) => {
    const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return time === 0 ? compareUtf8(left.id, right.id) : time;
  });
  const currentIndex = chronological.findIndex(({ id }) => id === input.currentRequestId);
  return currentIndex === -1 ? chronological : chronological.slice(0, currentIndex);
}

function messageCandidate(message: ChatMessage, turnIndex: number): ContextAssemblyCandidate {
  const owner = message.role === "user" ? "user" : "agent";
  return contextAssemblyCandidateSchema.parse({
    id: `working-message:${message.id}:${message.timestamp}`,
    layer: "working",
    owner,
    mutability: message.role === "user" ? "user-editable" : "agent-editable",
    modelVisibility: "conditional",
    authority: message.role === "user" ? "user" : "untrusted-data",
    reference: { namespace: "chat-message", id: message.id, revision: message.timestamp },
    source: { kind: "message", id: message.id, revision: message.timestamp },
    ordering: {
      turnIndex,
      completionState: "completed",
      eventTime: message.timestamp,
    },
    inclusionReasons: [{ kind: "recent", code: "recent-message" }],
    representations: [
      {
        kind: "full",
        id: "chat-message.content",
        version: "1",
        content: message.content,
      },
    ],
  });
}

function summaryCandidate(summary: RollingSummaryContext): ContextAssemblyCandidate {
  return contextAssemblyCandidateSchema.parse({
    id: `working-summary:${summary.sessionId}:${summary.revision}`,
    layer: "working",
    owner: "runtime",
    mutability: "runtime-only",
    modelVisibility: "conditional",
    authority: "untrusted-data",
    reference: {
      namespace: "session-summary",
      id: summary.sessionId,
      revision: summary.revision,
    },
    source: { kind: "runtime", id: summary.sessionId, revision: summary.revision },
    ordering: {
      turnIndex: 0,
      completionState: "completed",
      eventTime: summary.eventTime,
    },
    inclusionReasons: [{ kind: "active", code: "rolling-summary" }],
    representations: [
      {
        kind: "full",
        id: "rolling-summary.content",
        version: "1",
        content: summary.content,
      },
    ],
  });
}

/**
 * Adapt historical working state. The current request remains outside the hierarchy,
 * and messages after it are not historical context for that request.
 */
export function mapWorkingContextCandidates(
  input: WorkingContextInput
): ContextAssemblyCandidate[] {
  const summarySlots = input.rollingSummary ? 1 : 0;
  const messageLimit = WORKING_CONTEXT_CANDIDATE_MAX - summarySlots;
  const messages = priorMessages(input).slice(-messageLimit);
  return [
    ...(input.rollingSummary ? [summaryCandidate(input.rollingSummary)] : []),
    ...messages.map((message, index) => messageCandidate(message, index + 1)),
  ];
}
