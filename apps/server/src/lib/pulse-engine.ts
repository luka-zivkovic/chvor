import { generateText } from "ai";
import type { WSManager } from "../gateway/ws.ts";
import {
  getPulseConfig,
  recordPulseRun,
} from "../db/config-store.ts";
import { createModelForRole } from "./llm-router.ts";
import { getRecentErrors } from "./error-logger.ts";
import { listSchedules } from "../db/schedule-store.ts";
import { listCredentials } from "../db/credential-store.ts";
import { listWebhookSubscriptions, listWebhookEvents } from "../db/webhook-store.ts";
import { insertActivity } from "../db/activity-store.ts";
import { completeCognitiveLoop, failCognitiveLoop, startPulseCognitiveLoop } from "./cognitive-loop.ts";
import { startLoopPlaybook } from "./cognitive-loop-playbooks.ts";
import { runConsolidation } from "./memory-consolidation.ts";

let timer: ReturnType<typeof setInterval> | null = null;
let wsRef: WSManager | null = null;
let consecutiveSilent = 0;

// Escalation callback — set by daemon engine for auto-remediation
let onEscalation: ((resultText: string, healthContext: string, loopId?: string) => boolean) | null = null;

/** Register an escalation handler (called when pulse detects non-silent alerts). */
export function setEscalationHandler(handler: (resultText: string, healthContext: string, loopId?: string) => boolean): void {
  onEscalation = handler;
}

const PULSE_SYSTEM = `You are a health monitoring system. Review the system status below and decide if anything needs the user's attention.

Severity guide:
- CRITICAL: services down, repeated failures, credential expiration
- WARNING: isolated errors, degraded performance
- Ignore: transient single errors, normal operation

If nothing needs attention: respond with exactly PULSE_SILENT
Otherwise: one sentence describing the issue and a suggested action. Prefix with [CRITICAL] or [WARNING].`;

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 120;

export async function initPulse(ws: WSManager): Promise<void> {
  wsRef = ws;
  const config = getPulseConfig();
  if (config.enabled) arm(config.intervalMinutes);
  console.log(
    `[pulse] initialized (enabled: ${config.enabled}, interval: ${config.intervalMinutes}m)`
  );
}

export function syncPulse(): void {
  disarm();
  consecutiveSilent = 0;
  const config = getPulseConfig();
  if (config.enabled) arm(config.intervalMinutes);
}

export function shutdownPulse(): void {
  disarm();
  console.log("[pulse] shutdown");
}

/** Compute adaptive interval: backs off after consecutive silent pulses */
function getAdaptiveInterval(baseMinutes: number): number {
  if (consecutiveSilent > 5) return Math.min(baseMinutes * 4, MAX_INTERVAL_MINUTES);
  if (consecutiveSilent > 2) return Math.min(baseMinutes * 2, MAX_INTERVAL_MINUTES);
  return Math.max(baseMinutes, MIN_INTERVAL_MINUTES);
}

function arm(intervalMinutes: number): void {
  disarm();
  const effectiveMinutes = getAdaptiveInterval(intervalMinutes);
  const ms = effectiveMinutes * 60 * 1000;
  timer = setInterval(() => void runPulse(), ms);
  console.log(`[pulse] armed every ${effectiveMinutes}m (base: ${intervalMinutes}m, silent streak: ${consecutiveSilent})`);
}

function disarm(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function gatherHealthDelta(since: string | null): Promise<string> {
  const errors = getRecentErrors({ limit: 10, since: since ?? undefined });
  const failedSchedules = listSchedules().filter((s) => s.lastError);

  // Dynamic import to avoid circular dependency
  const { mcpManager } = await import("./mcp-manager.ts");
  const mcpStatus = await mcpManager.getConnectionStatus();

  const creds = listCredentials().filter(
    (c) => !c.testStatus || c.testStatus === "failed" || c.testStatus === "untested"
  );

  const lines: string[] = ["System health since last check:"];

  if (errors.length > 0) {
    const summary = errors
      .slice(0, 5)
      .map((e) => `[${e.category}] ${e.message.slice(0, 80)}`)
      .join(", ");
    lines.push(`- New errors (${errors.length}): ${summary}`);
  }

  if (mcpStatus.length > 0) {
    const down = mcpStatus.filter((m) => !m.connected);
    lines.push(`- MCP servers: ${mcpStatus.length - down.length}/${mcpStatus.length} running${down.length > 0 ? ` (down: ${down.map((d) => d.toolId).join(", ")})` : ""}`);
  }

  if (creds.length > 0) {
    lines.push(`- Unhealthy channels (${creds.length}): ${creds.map((c) => `${c.type}:${c.testStatus ?? "unknown"}`).join(", ")}`);
  }

  if (failedSchedules.length > 0) {
    lines.push(`- Failed schedules (${failedSchedules.length}): ${failedSchedules.map((s) => s.name).join(", ")}`);
  }

  // Webhook health checks
  const webhookSubs = listWebhookSubscriptions();
  const staleWebhooks = webhookSubs.filter((w) => {
    if (!w.enabled || !w.lastReceivedAt) return false;
    const hoursSince = (Date.now() - new Date(w.lastReceivedAt).getTime()) / 3_600_000;
    return hoursSince > 24;
  });
  if (staleWebhooks.length > 0) {
    lines.push(`- Stale webhooks (no events in 24h): ${staleWebhooks.map((w) => w.name).join(", ")}`);
  }

  const failingWebhooks = webhookSubs.filter((w) => {
    if (!w.enabled) return false;
    const events = listWebhookEvents(w.id, 10);
    if (events.length < 3) return false;
    const failedCount = events.filter((e) => e.error).length;
    return failedCount / events.length > 0.5;
  });
  if (failingWebhooks.length > 0) {
    lines.push(`- High-failure webhooks: ${failingWebhooks.map((w) => w.name).join(", ")}`);
  }

  if (lines.length === 1) {
    return "No changes since last check.";
  }

  return lines.join("\n");
}

async function runPulse(): Promise<void> {
  console.log("[pulse] firing awareness check (lightweight model, no tools)");

  try {
    const lastRunAt = getPulseConfig().lastRunAt;
    const healthContext = await gatherHealthDelta(lastRunAt);

    const model = createModelForRole("heartbeat");
    const result = await generateText({
      model,
      system: PULSE_SYSTEM,
      messages: [{ role: "user", content: `${healthContext}\n\nRun awareness pulse check now.` }],
      maxSteps: 1,
      maxTokens: 200,
    });

    const resultText = result.text.trim();

    if (resultText.includes("PULSE_SILENT") || !resultText) {
      consecutiveSilent++;
      console.log(`[pulse] nothing to report (silent streak: ${consecutiveSilent})`);
      recordPulseRun("silent", null);

      // Re-arm with adaptive interval after back-off threshold
      if (consecutiveSilent === 3 || consecutiveSilent === 6) {
        const pulseConfig = getPulseConfig();
        arm(pulseConfig.intervalMinutes);
      }
      return;
    }

    // Something flagged — parse severity prefix and reset silent counter
    consecutiveSilent = 0;
    let title = "Health Alert";
    let content = resultText;
    if (resultText.startsWith("[CRITICAL]")) {
      title = "Critical Health Alert";
      content = resultText.slice("[CRITICAL]".length).trim();
    } else if (resultText.startsWith("[WARNING]")) {
      title = "Health Warning";
      content = resultText.slice("[WARNING]".length).trim();
    }

    const entry = insertActivity({
      source: "pulse",
      title,
      content,
    });
    wsRef?.broadcast({ type: "activity.new", data: entry });

    const loop = startPulseCognitiveLoop(resultText, healthContext);
    startLoopPlaybook(loop.id, "health_anomaly", {
      alert: content,
      title,
    });

    // Notify daemon for auto-remediation immediately, then let memory sleep
    // run as the loop's reflective pass. If no daemon task is queued, the loop
    // can finish after consolidation rather than staying visually "running".
    const remediationQueued = onEscalation?.(resultText, healthContext, loop.id) ?? false;

    try {
      await runConsolidation({ loopId: loop.id, reason: "pulse", force: true });
      if (!remediationQueued) {
        completeCognitiveLoop(loop.id, "Loop completed", "Pulse recorded, memory consolidated, no daemon remediation queued.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!remediationQueued) {
        failCognitiveLoop(loop.id, "Loop failed during consolidation", message);
      }
    }

    recordPulseRun(resultText, null);

    // Re-arm at base interval since we got activity
    const pulseConfig = getPulseConfig();
    arm(pulseConfig.intervalMinutes);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[pulse] failed:", error);
    recordPulseRun(null, error);
  }
}
