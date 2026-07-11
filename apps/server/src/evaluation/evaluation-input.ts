import { redactTrajectoryText, type EvaluationCaseDocumentV1 } from "@chvor/shared";

export interface EvaluationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class UnsupportedEvaluationInputError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(value: unknown): EvaluationMessage | null {
  if (!isObject(value)) return null;
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant") return null;
  const content = typeof value.content === "string" ? value.content : value.text;
  if (typeof content !== "string" || !content.trim()) return null;
  return { role: value.role, content: redactTrajectoryText(content) };
}

/** Convert the portable A06 input forms into an explicit model-message contract. */
export function evaluationMessages(document: EvaluationCaseDocumentV1): EvaluationMessage[] {
  const input = document.input;
  if (typeof input === "string" && input.trim()) {
    return [{ role: "user", content: redactTrajectoryText(input) }];
  }
  if (isObject(input) && typeof input.prompt === "string" && input.prompt.trim()) {
    return [{ role: "user", content: redactTrajectoryText(input.prompt) }];
  }
  const candidates = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.messages)
      ? input.messages
      : null;
  if (candidates) {
    const messages = candidates.map(message);
    if (messages.every((entry): entry is EvaluationMessage => entry !== null) && messages.length) {
      return messages;
    }
  }
  throw new UnsupportedEvaluationInputError(
    "evaluation input must be a string, { prompt }, or an array/{ messages } of text messages"
  );
}
