import { getRetentionConfig, getSessionLifecycleConfig } from "../db/config-store.ts";
import { getStaleSessions, getRecentMessages, deleteSession, getActiveSessionIds } from "../db/session-store.ts";
import { extractAndStoreMemories } from "./memory-extractor.ts";
import { resetSession } from "./session-reset.ts";
import { clearSecrets } from "./sensitive-filter.ts";
import { pruneOldSnapshots } from "../db/emotion-store.ts";
import { startPeriodicJob, stopPeriodicJob } from "./job-runner.ts";
import { getConfig, setConfig } from "../db/config-store.ts";
import type { ChatMessage } from "@chvor/shared";

const ARCHIVE_WINDOW = 20; // messages per extraction call
const MAX_WINDOWS = 5; // max extraction calls per session

export async function runRetentionCleanup(): Promise<{ archived: number; deleted: number }> {
  const config = getRetentionConfig();

  if (config.sessionMaxAgeDays === 0) {
    console.log("[retention] session retention disabled (set to forever)");
    return { archived: 0, deleted: 0 };
  }

  const stale = getStaleSessions(config.sessionMaxAgeDays);
  if (stale.length === 0) return { archived: 0, deleted: 0 };

  let archived = 0;
  let deleted = 0;
  const failedSessionIds = new Set<string>();

  // Pre-deletion memory extraction
  if (config.archiveBeforeDelete) {
    for (const session of stale) {
      if (session.messageCount === 0) continue;
      try {
        const messages = getRecentMessages(session.id, MAX_WINDOWS * ARCHIVE_WINDOW);
        const windowCount = Math.min(MAX_WINDOWS, Math.ceil(messages.length / ARCHIVE_WINDOW));
        for (let i = 0; i < windowCount; i++) {
          const start = i * ARCHIVE_WINDOW;
          const window = messages.slice(start, start + ARCHIVE_WINDOW) as ChatMessage[];
          if (window.length === 0) break;
          await extractAndStoreMemories(window, session.channelType, session.id);
          archived++;
        }
      } catch (err) {
        failedSessionIds.add(session.id);
        console.error(`[retention] archival failed for session ${session.id}, skipping deletion:`, (err as Error).message);
      }
    }
  }

  // Delete per-session, skipping those with failed archival
  for (const session of stale) {
    if (failedSessionIds.has(session.id)) continue;
    if (deleteSession(session.id)) deleted++;
  }

  // Clear registered secrets to bound memory growth
  if (deleted > 0) clearSecrets();

  // Prune old emotion snapshots (same age as session retention)
  const emotionsPruned = pruneOldSnapshots(config.sessionMaxAgeDays);
  if (emotionsPruned > 0) {
    console.log(`[retention] pruned ${emotionsPruned} old emotion snapshot(s)`);
  }

  if (deleted > 0 || archived > 0) {
    console.log(`[retention] cleaned ${deleted} stale session(s), archived ${archived} window(s)`);
  }
  if (failedSessionIds.size > 0) {
    console.warn(`[retention] skipped ${failedSessionIds.size} session(s) due to archival failure`);
  }

  return { archived, deleted };
}

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export function startPeriodicCleanup(): void {
  startPeriodicJob({
    id: "retention-cleanup",
    intervalMs: CLEANUP_INTERVAL,
    run: async () => {
      await runRetentionCleanup();
    },
  });
}

export function stopPeriodicCleanup(): void {
  stopPeriodicJob("retention-cleanup");
}

// ── Daily session reset ──────────────────────────────────────

let dailyResetTimer: ReturnType<typeof setInterval> | null = null;

async function runDailyResetCheck(): Promise<void> {
  const config = getSessionLifecycleConfig();
  const resetHour = config.defaultPolicy.dailyResetHour;
  if (resetHour === null) return;

  const now = new Date();
  const currentHour = now.getHours();
  if (currentHour !== resetHour) return;

  // Prevent double-reset: check if we already ran today
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const lastResetDate = getConfig("session.lastDailyResetDate") ?? "";
  if (lastResetDate === today) return;

  const sessionIds = getActiveSessionIds();
  if (sessionIds.length === 0) {
    setConfig("session.lastDailyResetDate", today);
    return;
  }

  let resetCount = 0;
  for (const id of sessionIds) {
    try {
      await resetSession(id, `daily-reset (hour ${resetHour})`);
      resetCount++;
    } catch (err) {
      console.error(`[daily-reset] failed for session ${id}:`, (err as Error).message);
    }
  }

  setConfig("session.lastDailyResetDate", today);

  if (resetCount > 0) {
    console.log(`[daily-reset] reset ${resetCount} session(s) at hour ${resetHour}`);
  }
}

const DAILY_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

export function startDailyResetCheck(): void {
  if (dailyResetTimer) return;
  dailyResetTimer = setInterval(() => {
    runDailyResetCheck().catch((err) =>
      console.error("[daily-reset] check failed:", err)
    );
  }, DAILY_CHECK_INTERVAL);
  dailyResetTimer.unref();
}

export function stopDailyResetCheck(): void {
  if (dailyResetTimer) {
    clearInterval(dailyResetTimer);
    dailyResetTimer = null;
  }
}
