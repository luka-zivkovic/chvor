import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { RefreshCw } from "lucide-react";

interface ChvorDirs {
  home: string;
  app: string;
  data: string;
  logs: string;
  downloads: string;
  skills: string;
  tools: string;
  config: string;
}

export default function LogViewer() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function loadLogs() {
    try {
      const dirs = await invoke<ChvorDirs>("get_chvor_dirs", { instance: null });
      const logPath = `${dirs.logs}/server.log`;
      const content = await readTextFile(logPath);
      const allLines = content.split("\n");
      // Show last 200 lines
      setLines(allLines.slice(-200));
      setError(null);
    } catch {
      setError("No logs found yet");
      setLines([]);
    }
  }

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          Server Logs
        </span>
        <button
          onClick={loadLogs}
          className="p-1 rounded hover:bg-secondary transition-colors"
          title="Refresh logs"
        >
          <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed"
      >
        {error ? (
          <p className="text-muted-foreground">{error}</p>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap ${
                line.includes("ERROR") || line.includes("error")
                  ? "text-destructive"
                  : line.includes("WARN") || line.includes("warn")
                    ? "text-warning"
                    : "text-muted-foreground"
              }`}
            >
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
