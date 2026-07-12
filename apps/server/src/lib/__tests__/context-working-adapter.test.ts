import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@chvor/shared";
import {
  mapWorkingContextCandidates,
  WORKING_CONTEXT_CANDIDATE_MAX,
} from "../orchestrator/context-working-adapter.ts";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  timestamp: string
): ChatMessage {
  return { id, role, content, channelType: "web", timestamp };
}

describe("working context adapter", () => {
  it("maps the rolling summary and only messages prior to the current request", () => {
    const candidates = mapWorkingContextCandidates({
      messages: [
        message("current", "user", "CURRENT REQUEST MUST STAY OUT", "2026-07-12T10:02:00.000Z"),
        message("user-1", "user", "Earlier question", "2026-07-12T10:00:00.000Z"),
        message("assistant-1", "assistant", "Earlier answer", "2026-07-12T10:01:00.000Z"),
        message("after-current", "assistant", "Not historical yet", "2026-07-12T10:03:00.000Z"),
      ],
      currentRequestId: "current",
      rollingSummary: {
        sessionId: "session-1",
        revision: "summary-4",
        content: "Earlier rolling summary",
        eventTime: "2026-07-12T09:00:00.000Z",
      },
    });

    expect(candidates.map(({ reference }) => reference.id)).toEqual([
      "session-1",
      "user-1",
      "assistant-1",
    ]);
    expect(candidates.map(({ representations }) => representations[0].content)).toEqual([
      "Earlier rolling summary",
      "Earlier question",
      "Earlier answer",
    ]);
    expect(JSON.stringify(candidates)).not.toContain("CURRENT REQUEST MUST STAY OUT");
    expect(JSON.stringify(candidates)).not.toContain("Not historical yet");
  });

  it("derives deterministic chronology before assigning working turn indexes", () => {
    const candidates = mapWorkingContextCandidates({
      messages: [
        message("same-b", "assistant", "Second tie", "2026-07-12T10:01:00.000Z"),
        message("older", "user", "First", "2026-07-12T10:00:00.000Z"),
        message("same-a", "user", "First tie", "2026-07-12T10:01:00.000Z"),
      ],
      currentRequestId: "external-current-request",
    });

    expect(candidates.map(({ reference }) => reference.id)).toEqual(["older", "same-a", "same-b"]);
    expect(candidates.map(({ ordering }) => ordering.turnIndex)).toEqual([1, 2, 3]);
    expect(candidates.every(({ ordering }) => ordering.completionState === "completed")).toBe(true);
    expect(
      candidates
        .map(({ inclusionReasons }) => inclusionReasons)
        .every((reasons) => reasons.some(({ code }) => code === "recent-message"))
    ).toBe(true);
  });

  it("keeps message metadata out of model content", () => {
    const source = message("message-1", "assistant", "Visible answer", "2026-07-12T10:00:00.000Z");
    source.actions = [
      { tool: "private-tool", summary: "PRIVATE ACTION", timestamp: source.timestamp },
    ];
    const [candidate] = mapWorkingContextCandidates({
      messages: [source],
      currentRequestId: "current",
    });

    expect(candidate.representations).toEqual([
      {
        kind: "full",
        id: "chat-message.content",
        version: "1",
        content: "Visible answer",
      },
    ]);
    expect(JSON.stringify(candidate.representations)).not.toContain("PRIVATE ACTION");
  });

  it("keeps the newest bounded working set and reserves one slot for a summary", () => {
    const messages = Array.from({ length: 510 }, (_, index) =>
      message(
        `message-${String(index).padStart(3, "0")}`,
        index % 2 === 0 ? "user" : "assistant",
        `content-${index}`,
        new Date(Date.UTC(2026, 6, 12, 0, index)).toISOString()
      )
    );
    const candidates = mapWorkingContextCandidates({
      messages,
      currentRequestId: "external-current",
      rollingSummary: {
        sessionId: "session-bounded",
        revision: "1",
        content: "summary",
        eventTime: null,
      },
    });

    expect(candidates).toHaveLength(WORKING_CONTEXT_CANDIDATE_MAX);
    expect(candidates[0].reference.namespace).toBe("session-summary");
    expect(candidates[1].reference.id).toBe("message-011");
    expect(candidates.at(-1)?.reference.id).toBe("message-509");
  });
});
