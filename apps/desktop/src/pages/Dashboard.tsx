import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Play,
  Square,
  ExternalLink,
  RefreshCw,
  ArrowDownCircle,
  FileText,
  Loader2,
} from "lucide-react";
import ServerStatus from "../components/ServerStatus";
import LogViewer from "../components/LogViewer";
import { useServerStatus } from "../hooks/useServerStatus";

interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string | null;
  latestVersion: string;
}

interface ChvorConfig {
  installedVersion?: string;
  port: string;
  token?: string;
  onboarded: boolean;
  llmProvider?: string;
  instanceName?: string;
  templateName?: string;
}

export default function Dashboard() {
  const { running, pid, port, refresh } = useServerStatus();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [config, setConfig] = useState<ChvorConfig | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    invoke<ChvorConfig>("read_config", { instance: null }).then(setConfig);
    invoke<UpdateInfo>("check_server_update").then(setUpdateInfo).catch(() => {});

    // Listen for tray actions
    const unlisten = listen<string>("tray-action", (event) => {
      switch (event.payload) {
        case "start":
          handleStart();
          break;
        case "stop":
          handleStop();
          break;
        case "update":
          handleUpdate();
          break;
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleStart() {
    setStarting(true);
    try {
      await invoke("start_server", { port: config?.port || null });
      // Wait for health
      await invoke("poll_health", {
        port: config?.port || "3001",
        token: config?.token || null,
      });
      await refresh();
    } catch (e) {
      console.error("Failed to start:", e);
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await invoke("stop_server");
      await refresh();
    } catch (e) {
      console.error("Failed to stop:", e);
    } finally {
      setStopping(false);
    }
  }

  function handleOpen() {
    const p = port || config?.port || "3001";
    invoke("open_browser", { url: `http://localhost:${p}` });
  }

  async function handleUpdate() {
    setUpdating(true);
    try {
      await invoke("stop_server");
      await invoke("update_server");
      await invoke("start_server", { port: config?.port || null });
      await invoke("poll_health", {
        port: config?.port || "3001",
        token: config?.token || null,
      });
      // Refresh state
      const newConfig = await invoke<ChvorConfig>("read_config", { instance: null });
      setConfig(newConfig);
      setUpdateInfo(null);
      await refresh();
    } catch (e) {
      console.error("Update failed:", e);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-tight">chvor</h1>
          <ServerStatus running={running} pid={pid} port={port} />
        </div>
        <div className="flex items-center gap-2">
          {config?.installedVersion && (
            <span className="text-xs text-muted-foreground font-mono">
              v{config.installedVersion}
            </span>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Actions bar */}
        <div className="px-6 py-5">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Start / Stop */}
            {running ? (
              <button
                onClick={handleStop}
                disabled={stopping}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-sm font-medium hover:bg-destructive/15 disabled:opacity-50 transition-colors"
              >
                {stopping ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                Stop
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={starting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {starting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Start
              </button>
            )}

            {/* Open in browser */}
            <button
              onClick={handleOpen}
              disabled={!running}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open in Browser
            </button>

            {/* Toggle logs */}
            <button
              onClick={() => setShowLogs(!showLogs)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                showLogs
                  ? "bg-accent text-accent-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
              }`}
            >
              <FileText className="w-4 h-4" />
              Logs
            </button>

            {/* Refresh */}
            <button
              onClick={refresh}
              className="p-2 rounded-lg bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
              title="Refresh status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          {/* Update banner */}
          {updateInfo?.updateAvailable && (
            <div className="mt-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-accent border border-border animate-fade-in">
              <ArrowDownCircle className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">
                  Update available: v{updateInfo.latestVersion}
                </p>
                <p className="text-xs text-muted-foreground">
                  Currently running v{updateInfo.currentVersion}
                </p>
              </div>
              <button
                onClick={handleUpdate}
                disabled={updating}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {updating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowDownCircle className="w-3.5 h-3.5" />
                )}
                {updating ? "Updating..." : "Update Now"}
              </button>
            </div>
          )}
        </div>

        {/* Info cards */}
        {!showLogs && (
          <div className="px-6 grid grid-cols-3 gap-4 animate-fade-in">
            <InfoCard
              label="Port"
              value={port || config?.port || "3001"}
              mono
            />
            <InfoCard
              label="Provider"
              value={config?.llmProvider || "—"}
            />
            <InfoCard
              label="Status"
              value={running ? "Healthy" : "Offline"}
              accent={running ? "success" : "muted"}
            />
          </div>
        )}

        {/* Logs panel */}
        {showLogs && (
          <div className="flex-1 mx-6 mb-6 rounded-xl border border-border bg-card overflow-hidden animate-fade-in">
            <LogViewer />
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "success" | "muted";
}) {
  return (
    <div className="px-4 py-3 rounded-xl bg-card border border-border">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </p>
      <p
        className={`text-sm font-medium ${mono ? "font-mono" : ""} ${
          accent === "success"
            ? "text-success"
            : accent === "muted"
              ? "text-muted-foreground"
              : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
