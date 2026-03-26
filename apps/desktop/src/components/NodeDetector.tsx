import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, XCircle, Download, Loader2 } from "lucide-react";

interface NodeInfo {
  installed: boolean;
  version: string | null;
  meetsMinimum: boolean;
}

interface Props {
  onReady: () => void;
}

export default function NodeDetector({ onReady }: Props) {
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    checkNode();
  }, []);

  async function checkNode() {
    setChecking(true);
    try {
      const result = await invoke<NodeInfo>("detect_node");
      setInfo(result);
      if (result.installed && result.meetsMinimum) {
        onReady();
      }
    } catch {
      setInfo({ installed: false, version: null, meetsMinimum: false });
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall() {
    setInstalling(true);
    setInstallError(null);
    try {
      await invoke<string>("install_node");
      // Re-check after install
      await checkNode();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }

  if (checking) {
    return (
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Checking Node.js...</span>
      </div>
    );
  }

  if (info?.installed && info.meetsMinimum) {
    return (
      <div className="flex items-center gap-3 text-success animate-fade-in">
        <CheckCircle className="w-5 h-5" />
        <span>Node.js {info.version} detected</span>
      </div>
    );
  }

  if (info?.installed && !info.meetsMinimum) {
    return (
      <div className="space-y-3 animate-fade-in">
        <div className="flex items-center gap-3 text-warning">
          <XCircle className="w-5 h-5" />
          <span>
            Node.js {info.version} found — version 22+ required
          </span>
        </div>
        <button
          onClick={handleInstall}
          disabled={installing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {installing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          {installing ? "Installing..." : "Upgrade Node.js"}
        </button>
        {installError && (
          <p className="text-sm text-destructive">{installError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-center gap-3 text-muted-foreground">
        <XCircle className="w-5 h-5" />
        <span>Node.js not found</span>
      </div>
      <p className="text-sm text-muted-foreground">
        Chvor requires Node.js 22 or later to run.
      </p>
      <button
        onClick={handleInstall}
        disabled={installing}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {installing ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        {installing ? "Installing Node.js..." : "Install Node.js"}
      </button>
      {installError && (
        <p className="text-sm text-destructive">{installError}</p>
      )}
    </div>
  );
}
