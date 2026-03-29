import { useState, useEffect } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export function UpdateBanner() {
  const [update, setUpdate] = useState<{ version: string; body?: string } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    check()
      .then((u) => {
        if (!cancelled && u?.available) {
          setUpdate({ version: u.version, body: u.body ?? undefined });
        }
      })
      .catch((err) => console.warn("[updater] check failed:", err));
    return () => { cancelled = true; };
  }, []);

  if (!update || dismissed) return null;

  const handleUpdate = async () => {
    setInstalling(true);
    try {
      const u = await check();
      if (!u?.available) return;
      let totalBytes = 0;
      let downloadedBytes = 0;
      await u.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalBytes = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes > 0) setProgress(Math.round((downloadedBytes / totalBytes) * 100));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      await relaunch();
    } catch (err) {
      console.error("[updater] install failed:", err);
      setInstalling(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-2.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-block h-2 w-2 rounded-full bg-violet-400 animate-pulse shrink-0" />
        <span className="text-violet-200 truncate">
          {installing
            ? `Installing v${update.version}... ${progress}%`
            : `Update available: v${update.version}`}
        </span>
      </div>
      {!installing && (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setDismissed(true)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Later
          </button>
          <button
            onClick={handleUpdate}
            className="rounded-md bg-violet-500/20 px-3 py-1 text-xs font-medium text-violet-200 transition-colors hover:bg-violet-500/30"
          >
            Update Now
          </button>
        </div>
      )}
      {installing && (
        <div className="h-1 w-24 rounded-full bg-violet-500/20 overflow-hidden shrink-0">
          <div
            className="h-full rounded-full bg-violet-400 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
