import { watch, existsSync, type FSWatcher } from "node:fs";

let watchers: FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 300;

export function startSkillWatcher(
  dirs: string[],
  onReload: () => void,
): void {
  stopSkillWatcher();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (!filename || !filename.endsWith(".md")) return;

        // Debounce rapid changes
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`[skill-watcher] detected change in ${dir}/${filename}, reloading`);
          onReload();
        }, DEBOUNCE_MS);
      });

      watcher.on("error", (err) => {
        console.warn(`[skill-watcher] error watching ${dir}:`, err);
      });

      watchers.push(watcher);
      console.log(`[skill-watcher] watching ${dir}`);
    } catch (err) {
      console.warn(`[skill-watcher] failed to watch ${dir}:`, err);
    }
  }
}

export function stopSkillWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers = [];
}
