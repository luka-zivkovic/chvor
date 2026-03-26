import { checkForUpdates } from "./registry-manager.ts";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let timer: ReturnType<typeof setInterval> | null = null;

type BroadcastFn = (event: {
  type: "registry.updatesAvailable";
  data: { count: number; entries: { id: string; kind: string; current: string; available: string }[]; skills: { id: string; current: string; available: string }[] };
}) => void;

export function startAutoUpdate(
  broadcast: BroadcastFn,
  intervalMs = DEFAULT_INTERVAL_MS,
): void {
  stopAutoUpdate();

  // Initial check after 30s delay (let server finish starting up)
  const initialDelay = setTimeout(async () => {
    await runCheck(broadcast);
  }, 30_000);

  timer = setInterval(async () => {
    await runCheck(broadcast);
  }, intervalMs);

  // Store the initial delay so we can clear it
  (timer as unknown as { __initialDelay?: ReturnType<typeof setTimeout> }).__initialDelay = initialDelay;

  console.log(`[registry-updater] auto-update check every ${Math.round(intervalMs / 60_000)}m`);
}

async function runCheck(broadcast: BroadcastFn): Promise<void> {
  try {
    const updates = await checkForUpdates();
    if (updates.length > 0) {
      console.log(`[registry-updater] ${updates.length} update(s) available`);
      broadcast({
        type: "registry.updatesAvailable",
        data: {
          count: updates.length,
          entries: updates.map((u) => ({
            id: u.id,
            kind: u.kind,
            current: u.current,
            available: u.available,
          })),
          // backward compat
          skills: updates.map((u) => ({
            id: u.id,
            current: u.current,
            available: u.available,
          })),
        },
      });
    }
  } catch (err) {
    console.warn("[registry-updater] update check failed:", err);
  }
}

export function stopAutoUpdate(): void {
  if (timer) {
    const t = timer as unknown as { __initialDelay?: ReturnType<typeof setTimeout> };
    if (t.__initialDelay) clearTimeout(t.__initialDelay);
    clearInterval(timer);
    timer = null;
  }
}
