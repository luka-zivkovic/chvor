import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ServerStatus {
  running: boolean;
  pid: number | null;
  port: string | null;
}

export function useServerStatus(pollMs = 3000) {
  const [status, setStatus] = useState<ServerStatus>({
    running: false,
    pid: null,
    port: null,
  });

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<ServerStatus>("server_status");
      setStatus(s);
    } catch {
      setStatus({ running: false, pid: null, port: null });
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollMs);
    return () => clearInterval(interval);
  }, [refresh, pollMs]);

  return { ...status, refresh };
}
