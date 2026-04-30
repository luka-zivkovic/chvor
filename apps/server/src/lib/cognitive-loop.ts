import type {
  A2UIComponentEntry,
  CognitiveLoopEvent,
  CognitiveLoopRun,
  CognitiveLoopSeverity,
  CognitiveLoopStage,
} from "@chvor/shared";
import {
  appendCognitiveLoopEvent as appendStoredCognitiveLoopEvent,
  createCognitiveLoopRun,
  getCognitiveLoopRun,
  listRunningCognitiveLoopRuns,
  listCognitiveLoopEvents,
  updateCognitiveLoopRun,
} from "../db/cognitive-loop-store.ts";
import { updateBindings, upsertSurface } from "../db/a2ui-store.ts";
import { getWSInstance } from "../gateway/ws-instance.ts";

const FINAL_STAGES = new Set<CognitiveLoopStage>(["loop.completed", "loop.failed"]);

function broadcastRun(run: CognitiveLoopRun): void {
  getWSInstance()?.broadcast({ type: "cognitive.loop.run", data: run });
}

function broadcastEvent(event: CognitiveLoopEvent): void {
  getWSInstance()?.broadcast({ type: "cognitive.loop.event", data: event });
}

function eventTableRows(events: CognitiveLoopEvent[]): Array<{ time: string; stage: string; title: string }> {
  return events.slice(-10).map((event) => ({
    time: new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    stage: event.stage.replace(/\./g, " › "),
    title: event.title,
  }));
}

function loopAction(eventName: string, loopId: string): string {
  return `emit:${eventName}?${encodeURIComponent(JSON.stringify({ loopId }))}`;
}

function metadataValue(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function playbookLine(events: CognitiveLoopEvent[]): string {
  const playbook = events.find((event) => event.stage === "playbook.started");
  if (!playbook) return "Playbook: implicit loop";
  const name = metadataValue(playbook.metadata, "name") ?? metadataValue(playbook.metadata, "playbookId") ?? "Autonomous playbook";
  const stepCount = Array.isArray(playbook.metadata?.steps) ? playbook.metadata.steps.length : null;
  return `${name}${stepCount ? ` • ${stepCount} steps` : ""}`;
}

function severityFromText(resultText: string): CognitiveLoopSeverity {
  if (resultText.startsWith("[CRITICAL]")) return "critical";
  if (resultText.startsWith("[WARNING]")) return "warning";
  return "info";
}

function stripSeverity(resultText: string): string {
  return resultText.replace(/^\[(CRITICAL|WARNING)]\s*/i, "").trim();
}

function surfaceComponents(loopId: string): A2UIComponentEntry[] {
  return [
    {
      id: "title",
      component: { Text: { text: { literalString: "Autonomous Cognitive Loop" }, usageHint: "h2" } },
    },
    {
      id: "summary",
      component: { Text: { text: { binding: "summary" }, usageHint: "body" } },
    },
    {
      id: "status",
      component: { Text: { text: { binding: "statusLine" }, usageHint: "caption" } },
    },
    {
      id: "playbook",
      component: { Text: { text: { binding: "playbookLine" }, usageHint: "caption" } },
    },
    {
      id: "events",
      component: {
        Table: {
          columns: [
            { key: "time", label: "Time" },
            { key: "stage", label: "Stage" },
            { key: "title", label: "Event" },
          ],
          rows: { binding: "events" },
          emptyText: "Waiting for loop events…",
        },
      },
    },
    {
      id: "retry",
      component: {
        Button: {
          label: { literalString: "Retry step" },
          action: loopAction("cognitive_loop.retry", loopId),
          variant: "secondary",
        },
      },
    },
    {
      id: "escalate",
      component: {
        Button: {
          label: { literalString: "Escalate" },
          action: loopAction("cognitive_loop.escalate", loopId),
          variant: "primary",
        },
      },
    },
    {
      id: "open-activity",
      component: {
        Button: {
          label: { literalString: "Open activity" },
          action: "navigate:activity",
          variant: "ghost",
        },
      },
    },
    {
      id: "actions",
      component: { Row: { children: { explicitList: ["retry", "escalate", "open-activity"] }, gap: 8, align: "start" } },
    },
    {
      id: "root",
      component: { Column: { children: { explicitList: ["title", "summary", "status", "playbook", "events", "actions"] }, gap: 10, align: "start" } },
    },
  ];
}

function componentMap(entries: A2UIComponentEntry[]): Record<string, A2UIComponentEntry> {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry]));
}

// Track which loops have already had their A2UI surface schema published.
// The schema (component tree) is identical for every event in a given loop —
// only `bindings` change as events accrue. By republishing the schema once
// (or on toast), follow-up events do a cheap bindings-only DB write + a
// single `a2ui.data` broadcast instead of two writes + two broadcasts.
const surfacePublished = new Set<string>();

function refreshLoopDashboard(loopId: string, opts: { toast?: boolean } = {}): void {
  const run = getCognitiveLoopRun(loopId);
  if (!run) return;
  const surfaceId = run.surfaceId ?? `cognitive-loop-${run.id}`;
  const events = listCognitiveLoopEvents(run.id);
  const components = surfaceComponents(run.id);
  const bindings = {
    summary: run.summary,
    statusLine: `${run.severity.toUpperCase()} • ${run.status} • ${run.currentStage?.replace(/\./g, " › ") ?? "starting"}`,
    playbookLine: playbookLine(events),
    events: eventTableRows(events),
  };

  const isFinalStatus = run.status === "completed" || run.status === "failed";
  const needsSchema = opts.toast || !surfacePublished.has(surfaceId);

  try {
    if (needsSchema) {
      upsertSurface({
        surfaceId,
        title: run.title,
        root: "root",
        components: componentMap(components),
        rendering: true,
      });
      surfacePublished.add(surfaceId);
    }
    updateBindings(surfaceId, bindings);
  } catch (err) {
    console.warn("[cognitive-loop] dashboard persistence skipped:", err instanceof Error ? err.message : String(err));
  }

  const ws = getWSInstance();
  if (needsSchema) {
    ws?.broadcast({ type: "a2ui.surface", data: { surfaceId, title: run.title, components, root: "root" } });
  }
  ws?.broadcast({ type: "a2ui.data", data: { surfaceId, bindings } });
  if (opts.toast) {
    ws?.broadcast({ type: "a2ui.toast", data: { surfaceId, title: "Cognitive loop started" } });
  }
  if (isFinalStatus) surfacePublished.delete(surfaceId);
}

export function startPulseCognitiveLoop(resultText: string, healthContext: string): CognitiveLoopRun {
  const severity = severityFromText(resultText);
  const summary = stripSeverity(resultText) || resultText.slice(0, 500);
  const run = createCognitiveLoopRun({
    title: severity === "critical" ? "Critical autonomous loop" : "Autonomous health loop",
    severity,
    trigger: "pulse",
    summary,
  });
  const surfaceId = `cognitive-loop-${run.id}`;
  const withSurface = updateCognitiveLoopRun(run.id, { surfaceId }) ?? run;
  broadcastRun(withSurface);
  appendCognitiveLoopEvent(withSurface.id, "pulse.detected", "Pulse detected a health delta", healthContext, {
    severity,
    summary,
  }, { toast: true });
  appendCognitiveLoopEvent(withSurface.id, "a2ui.surface.pinned", "Pinned live loop dashboard", null, {
    surfaceId,
  });
  return withSurface;
}

export function startA2UICognitiveLoop(eventName: string, surfaceId: string, sourceId?: string): CognitiveLoopRun {
  const run = createCognitiveLoopRun({
    title: `A2UI action loop: ${eventName}`,
    severity: "info",
    trigger: "a2ui",
    summary: `User triggered ${eventName} from ${surfaceId}${sourceId ? `/${sourceId}` : ""}.`,
  });
  const loopSurfaceId = `cognitive-loop-${run.id}`;
  const withSurface = updateCognitiveLoopRun(run.id, { surfaceId: loopSurfaceId }) ?? run;
  broadcastRun(withSurface);
  appendCognitiveLoopEvent(withSurface.id, "a2ui.action.received", "A2UI action received", null, {
    eventName,
    sourceSurfaceId: surfaceId,
    sourceId,
  }, { toast: true });
  return withSurface;
}

export function appendCognitiveLoopEvent(
  loopId: string | null | undefined,
  stage: CognitiveLoopStage,
  title: string,
  body?: string | null,
  metadata?: Record<string, unknown> | null,
  opts: { toast?: boolean } = {},
): CognitiveLoopEvent | null {
  if (!loopId) return null;
  const event = appendStoredCognitiveLoopEvent({ loopId, stage, title, body, metadata });
  const status = stage === "loop.failed" ? "failed" : stage === "loop.completed" ? "completed" : undefined;
  const run = updateCognitiveLoopRun(loopId, {
    currentStage: stage,
    ...(status ? { status, completedAt: new Date().toISOString() } : {}),
  });
  if (run) broadcastRun(run);
  broadcastEvent(event);
  refreshLoopDashboard(loopId, { toast: opts.toast });
  return event;
}

export function completeCognitiveLoop(loopId: string | null | undefined, title = "Loop completed", body?: string | null): void {
  appendCognitiveLoopEvent(loopId, "loop.completed", title, body ?? null);
}

export function pauseCognitiveLoop(loopId: string | null | undefined, title = "Loop paused", body?: string | null): void {
  if (!loopId) return;
  const event = appendStoredCognitiveLoopEvent({ loopId, stage: "loop.paused", title, body: body ?? null });
  const run = updateCognitiveLoopRun(loopId, { status: "paused", currentStage: "loop.paused" });
  if (run) broadcastRun(run);
  broadcastEvent(event);
  refreshLoopDashboard(loopId);
}

export function resumeCognitiveLoop(loopId: string | null | undefined, title = "Loop resumed", body?: string | null): void {
  if (!loopId) return;
  const event = appendStoredCognitiveLoopEvent({ loopId, stage: "loop.resumed", title, body: body ?? null });
  const run = updateCognitiveLoopRun(loopId, { status: "running", currentStage: "loop.resumed", completedAt: null });
  if (run) broadcastRun(run);
  broadcastEvent(event);
  refreshLoopDashboard(loopId);
}

export function failCognitiveLoop(loopId: string | null | undefined, title = "Loop failed", body?: string | null): void {
  appendCognitiveLoopEvent(loopId, "loop.failed", title, body ?? null);
}

export function isFinalCognitiveLoopStage(stage: CognitiveLoopStage): boolean {
  return FINAL_STAGES.has(stage);
}

export function recoverStaleCognitiveLoops(maxAgeMs = 30 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let recovered = 0;
  for (const run of listRunningCognitiveLoopRuns()) {
    if (new Date(run.updatedAt).getTime() > cutoff) continue;
    appendCognitiveLoopEvent(
      run.id,
      "loop.failed",
      "Loop marked stale",
      `No loop activity for ${Math.round(maxAgeMs / 60000)} minutes.`,
    );
    recovered++;
  }
  return recovered;
}
