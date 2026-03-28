import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Rocket, Cpu, Zap, CheckCircle, Loader2, ArrowRight, ArrowLeft } from "lucide-react";
import NodeDetector from "../components/NodeDetector";

interface DownloadProgress {
  stage: string;
  percent: number;
  message: string;
}

interface Props {
  onComplete: () => void;
}

const STEPS = [
  { icon: Rocket, title: "Welcome" },
  { icon: Cpu, title: "Environment" },
  { icon: Zap, title: "Launch" },
];

function isValidPort(value: string): boolean {
  const num = parseInt(value, 10);
  return !isNaN(num) && num >= 1024 && num <= 65535;
}

export default function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [nodeReady, setNodeReady] = useState(false);

  // Launch step state
  const [port, setPort] = useState("9147");
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleLaunch() {
    if (!isValidPort(port)) {
      setError("Port must be a number between 1024 and 65535.");
      return;
    }

    setInstalling(true);
    setError(null);
    try {
      // Generate token
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

      // Write config WITHOUT onboarded flag — we set it only after full success
      await invoke("write_config", {
        config: {
          port,
          token,
          onboarded: false,
        },
        instance: null,
      });

      // Resolve & download latest version
      const version = await invoke<string>("resolve_latest_version");
      await invoke("download_release", { version });

      // Start server
      await invoke("start_server", { port });

      // Wait for health
      const healthy = await invoke<boolean>("poll_health", { port, token });
      if (!healthy) {
        setError("Server started but health check timed out. Check logs for details.");
        setInstalling(false);
        return;
      }

      // Auto-detect timezone and configure persona via Rust backend
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        await invoke("configure_persona", { port, token, timezone });
      } catch {
        // Non-fatal
      }

      // Now mark as onboarded — only after full success
      await invoke("write_config", {
        config: {
          port,
          token,
          onboarded: true,
          installedVersion: version,
        },
        instance: null,
      });

      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }

  function handleOpenBrowser() {
    invoke("open_browser", { url: `http://localhost:${port}` });
    onComplete();
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar — step indicator */}
      <div className="w-56 border-r border-border bg-card/50 p-6 flex flex-col gap-1">
        <div className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight">chvor</h1>
          <p className="text-xs text-muted-foreground mt-1">Setup</p>
        </div>
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const isActive = i === step;
          const isComplete = i < step;
          return (
            <div
              key={i}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-accent text-accent-foreground"
                  : isComplete
                    ? "text-foreground"
                    : "text-muted-foreground"
              }`}
            >
              {isComplete ? (
                <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
              ) : (
                <Icon className="w-4 h-4 flex-shrink-0" />
              )}
              <span className={isActive ? "font-medium" : ""}>{s.title}</span>
            </div>
          );
        })}
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex items-center justify-center p-10">
          <div className="w-full max-w-md">
            {/* Step 0: Welcome */}
            {step === 0 && (
              <div className="space-y-6 animate-fade-in">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Welcome to Chvor
                  </h2>
                  <p className="text-muted-foreground mt-2 leading-relaxed">
                    Your own AI — built by you, visible to you, unique to you.
                  </p>
                  <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                    This wizard will set up everything you need. It takes about
                    two minutes.
                  </p>
                </div>
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
                >
                  Get Started
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Step 1: Environment check */}
            {step === 1 && (
              <div className="space-y-6 animate-fade-in">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Environment
                  </h2>
                  <p className="text-muted-foreground mt-2 text-sm">
                    Checking that your system has what Chvor needs.
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-card border border-border">
                  <NodeDetector onReady={() => setNodeReady(true)} />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => setStep(0)}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground text-sm hover:opacity-90 transition-opacity"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back
                  </button>
                  <button
                    onClick={() => setStep(2)}
                    disabled={!nodeReady}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
                  >
                    Continue
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Launch */}
            {step === 2 && (
              <div className="space-y-6 animate-fade-in">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    {done ? "You're all set!" : "Install & Launch"}
                  </h2>
                  {!done && (
                    <p className="text-muted-foreground mt-2 text-sm">
                      We'll download Chvor and start the server. You can add your API key in Settings once you're in.
                    </p>
                  )}
                </div>

                {!installing && !done && (
                  <>
                    <div className="space-y-2">
                      <label className="block text-sm text-muted-foreground">
                        Port
                      </label>
                      <input
                        type="number"
                        min={1024}
                        max={65535}
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        className="w-24 px-3 py-2 rounded-lg bg-input border border-border text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring/40 transition-shadow"
                      />
                      {port && !isValidPort(port) && (
                        <p className="text-xs text-destructive">
                          Port must be between 1024 and 65535
                        </p>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setStep(1)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-secondary-foreground text-sm hover:opacity-90 transition-opacity"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        Back
                      </button>
                      <button
                        onClick={handleLaunch}
                        disabled={!isValidPort(port)}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
                      >
                        <Zap className="w-4 h-4" />
                        Install & Start
                      </button>
                    </div>
                  </>
                )}

                {installing && progress && (
                  <div className="space-y-3 animate-fade-in">
                    <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {progress.message}
                    </p>
                  </div>
                )}

                {installing && !progress && (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span className="text-sm">Preparing...</span>
                  </div>
                )}

                {error && (
                  <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                    <p className="text-sm text-destructive">{error}</p>
                  </div>
                )}

                {done && (
                  <div className="space-y-4 animate-slide-up">
                    <div className="flex items-center gap-3 text-success">
                      <CheckCircle className="w-5 h-5" />
                      <span className="font-medium">
                        Chvor is running at localhost:{port}
                      </span>
                    </div>
                    <button
                      onClick={handleOpenBrowser}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
                    >
                      <Rocket className="w-4 h-4" />
                      Open Chvor
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
