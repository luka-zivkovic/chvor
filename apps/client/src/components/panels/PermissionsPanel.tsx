import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type {
  PcSafetyLevel,
  ShellApprovalMode,
  FilesystemConfig,
  TrustedCommandsConfig,
  SandboxConfig,
  SandboxStatus,
} from "@chvor/shared";

/* ─── Reusable toggle switch ─── */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
        checked ? "bg-primary" : "bg-muted-foreground/25"
      }`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-[14px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

const SAFETY_DESCRIPTIONS: Record<PcSafetyLevel, string> = {
  supervised: "Every action requires your approval before execution. Safest option.",
  "semi-autonomous": "Known-safe actions (keyboard shortcuts, simple clicks) auto-execute. Complex or LLM-planned actions require approval.",
  autonomous: "All actions execute without approval. Use only in trusted environments.",
};

const SHELL_DESCRIPTIONS: Record<ShellApprovalMode, string> = {
  always_approve: "All commands run immediately without asking. Only use if you trust the AI fully.",
  dangerous_only: "Safe and moderate commands run freely. Dangerous commands (rm, sudo, etc.) require approval.",
  moderate_plus: "Only safe read-only commands run freely. Anything that writes or modifies requires approval.",
  block_all: "No shell commands can run. The AI cannot execute anything on your system.",
};

export function PermissionsContent() {
  // PC Control state
  const [pcEnabled, setPcEnabled] = useState(false);
  const [pcSafetyLevel, setPcSafetyLevel] = useState<PcSafetyLevel>("supervised");
  const [pcLocalAvailable, setPcLocalAvailable] = useState(false);

  // Shell Commands state
  const [shellApprovalMode, setShellApprovalMode] = useState<ShellApprovalMode>("dangerous_only");

  // Network state
  const [allowLocalhost, setAllowLocalhost] = useState(false);

  // Filesystem state
  const [fsConfig, setFsConfig] = useState<FilesystemConfig | null>(null);
  const [newPath, setNewPath] = useState("");

  // Trusted commands state
  const [trusted, setTrusted] = useState<TrustedCommandsConfig | null>(null);

  // Code Sandbox state
  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
  const [pullingImages, setPullingImages] = useState(false);

  /* ─── Load configs on mount ─── */
  useEffect(() => {
    api.pc
      .config()
      .then((cfg) => {
        setPcEnabled(cfg.enabled);
        setPcSafetyLevel(cfg.safetyLevel);
        setPcLocalAvailable(cfg.localAvailable);
      })
      .catch(() => {});

    api.shellConfig
      .get()
      .then((cfg) => setShellApprovalMode(cfg.approvalMode))
      .catch(() => {});

    api.securityConfig
      .get()
      .then((cfg) => setAllowLocalhost(cfg.allowLocalhost))
      .catch(() => {});

    api.securityConfig
      .getFilesystem()
      .then(setFsConfig)
      .catch(() => {});

    api.securityConfig
      .getTrusted()
      .then(setTrusted)
      .catch(() => {});

    api.sandboxConfig
      .get()
      .then(setSandboxConfig)
      .catch(() => {});

    api.sandboxConfig
      .status()
      .then(setSandboxStatus)
      .catch(() => {});
  }, []);

  /* ─── Handlers ─── */
  const handlePcToggle = async () => {
    const next = !pcEnabled;
    setPcEnabled(next);
    try {
      const result = await api.pc.setConfig({ enabled: next });
      setPcEnabled(result.enabled);
      setPcSafetyLevel(result.safetyLevel);
    } catch {
      setPcEnabled(!next);
      toast.error("Failed to toggle PC control");
    }
  };

  const handlePcSafetyChange = async (level: PcSafetyLevel) => {
    const prev = pcSafetyLevel;
    setPcSafetyLevel(level);
    try {
      await api.pc.setConfig({ safetyLevel: level });
    } catch {
      setPcSafetyLevel(prev);
      toast.error("Failed to update safety level");
    }
  };

  const handleLocalhostToggle = async () => {
    const next = !allowLocalhost;
    setAllowLocalhost(next);
    try {
      const result = await api.securityConfig.update({ allowLocalhost: next });
      setAllowLocalhost(result.allowLocalhost);
    } catch {
      setAllowLocalhost(!next);
      toast.error("Failed to update localhost access");
    }
  };

  const handleShellApprovalChange = async (mode: ShellApprovalMode) => {
    const prev = shellApprovalMode;
    setShellApprovalMode(mode);
    try {
      await api.shellConfig.update({ approvalMode: mode });
    } catch {
      setShellApprovalMode(prev);
      toast.error("Failed to update shell approval mode");
    }
  };

  const handleFsUpdate = async (updates: Partial<FilesystemConfig>) => {
    if (!fsConfig) return;
    const prev = { ...fsConfig };
    setFsConfig({ ...fsConfig, ...updates });
    try {
      const result = await api.securityConfig.updateFilesystem(updates);
      setFsConfig(result);
    } catch {
      setFsConfig(prev);
      toast.error("Failed to update filesystem config");
    }
  };

  const handleAddPath = () => {
    const p = newPath.trim();
    if (!p || !fsConfig) return;
    if (fsConfig.allowedPaths.includes(p)) {
      toast.error("Path already in list");
      return;
    }
    handleFsUpdate({ allowedPaths: [...fsConfig.allowedPaths, p] });
    setNewPath("");
  };

  const handleRemovePath = (path: string) => {
    if (!fsConfig) return;
    handleFsUpdate({ allowedPaths: fsConfig.allowedPaths.filter((p) => p !== path) });
  };

  const handleRemoveTrusted = async (kind: "shell" | "pc", pattern: string) => {
    try {
      const result = await api.securityConfig.removeTrusted(kind, pattern);
      setTrusted(result);
    } catch {
      toast.error("Failed to remove trusted command");
    }
  };

  const handleSandboxUpdate = async (updates: Partial<SandboxConfig>) => {
    if (!sandboxConfig) return;
    const prev = { ...sandboxConfig };
    setSandboxConfig({ ...sandboxConfig, ...updates });
    try {
      const result = await api.sandboxConfig.update(updates);
      setSandboxConfig(result);
    } catch {
      setSandboxConfig(prev);
      toast.error("Failed to update sandbox config");
    }
  };

  const handlePullImages = async () => {
    setPullingImages(true);
    try {
      await api.sandboxConfig.pull();
      toast.success("Images pulled successfully");
      const status = await api.sandboxConfig.status();
      setSandboxStatus(status);
    } catch {
      toast.error("Failed to pull sandbox images");
    } finally {
      setPullingImages(false);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      {/* ─── PC Control ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          PC Control
        </h3>
        <div className="flex flex-col divide-y divide-border/30">
          <div className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">Enable PC control</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Control screen, mouse, keyboard, and shell
                </p>
              </div>
              <Toggle checked={pcEnabled} onChange={handlePcToggle} label="Toggle PC control" />
            </div>
            {pcEnabled && (
              <div className="mt-2">
                <label className="mb-1 block text-[10px] text-muted-foreground">Safety level</label>
                <select
                  value={pcSafetyLevel}
                  onChange={(e) => handlePcSafetyChange(e.target.value as PcSafetyLevel)}
                  className="w-full rounded border border-border/40 bg-transparent px-2 py-1.5 text-[11px] text-foreground"
                >
                  <option value="supervised">Supervised</option>
                  <option value="semi-autonomous">Semi-autonomous</option>
                  <option value="autonomous">Autonomous</option>
                </select>
                <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                  {SAFETY_DESCRIPTIONS[pcSafetyLevel]}
                </p>
                {!pcLocalAvailable && (
                  <p className="mt-1.5 text-[10px] text-amber-500/80">
                    No local backend detected. Install the PC agent for full control.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ─── Shell Commands ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Shell Commands
        </h3>
        <div className="flex flex-col divide-y divide-border/30">
          <div className="pb-3">
            <div>
              <p className="text-xs font-medium text-foreground">Approval mode</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Control which shell commands run without approval
              </p>
            </div>
            <select
              value={shellApprovalMode}
              onChange={(e) => handleShellApprovalChange(e.target.value as ShellApprovalMode)}
              className="mt-2 w-full rounded border border-border/40 bg-transparent px-2 py-1.5 text-[11px] text-foreground"
            >
              <option value="always_approve">Always approve</option>
              <option value="dangerous_only">Block dangerous</option>
              <option value="moderate_plus">Block moderate + dangerous</option>
              <option value="block_all">Block all</option>
            </select>
            <p className="mt-1.5 text-[10px] text-muted-foreground/70">
              {SHELL_DESCRIPTIONS[shellApprovalMode]}
            </p>
          </div>
        </div>
      </section>

      {/* ─── Network ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Network
        </h3>
        <div className="flex flex-col divide-y divide-border/30">
          <div className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">Allow localhost access</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Allow the AI to access localhost and private network addresses
                </p>
              </div>
              <Toggle checked={allowLocalhost} onChange={handleLocalhostToggle} label="Toggle localhost access" />
            </div>
          </div>
        </div>
      </section>

      {/* ─── Filesystem ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Filesystem Access
        </h3>
        <p className="text-[10px] text-amber-500/80 mb-3">
          These settings are advisory preferences. Server-side enforcement is not yet implemented.
        </p>
        {fsConfig ? (
          <div className="flex flex-col divide-y divide-border/30">
            <div className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-foreground">Enable filesystem access</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Allow the AI to read and write files on your system
                  </p>
                </div>
                <Toggle
                  checked={fsConfig.enabled}
                  onChange={() => handleFsUpdate({ enabled: !fsConfig.enabled })}
                  label="Toggle filesystem access"
                />
              </div>

              {fsConfig.enabled && (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-foreground">Read-only mode</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Restrict the AI to only reading files, no writing
                      </p>
                    </div>
                    <Toggle
                      checked={fsConfig.readOnly}
                      onChange={() => handleFsUpdate({ readOnly: !fsConfig.readOnly })}
                      label="Toggle read-only mode"
                    />
                  </div>

                  <div>
                    <p className="text-xs font-medium text-foreground mb-2">Allowed directories</p>
                    <p className="text-[10px] text-muted-foreground/70 mb-2">
                      The AI can only access files within these directories.
                    </p>
                    <div className="flex flex-col gap-1.5 mb-2">
                      {fsConfig.allowedPaths.map((path) => (
                        <div
                          key={path}
                          className="flex items-center justify-between rounded-md border border-border/40 px-2.5 py-1.5"
                        >
                          <span className="font-mono text-[10px] text-foreground/80 truncate mr-2">{path}</span>
                          <button
                            onClick={() => handleRemovePath(path)}
                            className="shrink-0 text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                            aria-label={`Remove ${path}`}
                          >
                            x
                          </button>
                        </div>
                      ))}
                      {fsConfig.allowedPaths.length === 0 && (
                        <p className="text-[10px] text-muted-foreground/50">No allowed directories. AI cannot access any files.</p>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        className="flex-1 rounded border border-border/40 bg-transparent px-2 py-1.5 text-[11px] text-foreground font-mono"
                        placeholder="/path/to/directory"
                        value={newPath}
                        onChange={(e) => setNewPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); handleAddPath(); }
                        }}
                      />
                      <button
                        onClick={handleAddPath}
                        className="shrink-0 rounded border border-border/40 px-3 py-1.5 text-[10px] font-medium text-foreground hover:bg-white/5 transition-colors"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">Loading...</p>
        )}
      </section>

      {/* ─── Trusted Commands ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Trusted Commands
        </h3>
        <p className="text-[10px] text-muted-foreground/70 mb-3">
          Commands you've marked as "Always Allow" will auto-approve without prompting.
          Remove them here to require approval again.
        </p>
        {trusted ? (
          <div className="flex flex-col gap-3">
            {/* Shell */}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-1.5">Shell</p>
              {trusted.shell.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {trusted.shell.map((pattern) => (
                    <span
                      key={pattern}
                      className="inline-flex items-center gap-1 rounded-md bg-muted/50 border border-border/30 px-2 py-0.5 font-mono text-[10px] text-foreground"
                    >
                      {pattern}
                      <button
                        onClick={() => handleRemoveTrusted("shell", pattern)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={`Remove trusted pattern: ${pattern}`}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground/50">No trusted shell commands.</p>
              )}
            </div>

            {/* PC */}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground mb-1.5">PC Control</p>
              {trusted.pc.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {trusted.pc.map((pattern) => (
                    <span
                      key={pattern}
                      className="inline-flex items-center gap-1 rounded-md bg-muted/50 border border-border/30 px-2 py-0.5 font-mono text-[10px] text-foreground"
                    >
                      {pattern}
                      <button
                        onClick={() => handleRemoveTrusted("pc", pattern)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={`Remove trusted pattern: ${pattern}`}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground/50">No trusted PC actions.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">Loading...</p>
        )}
      </section>

      {/* ─── Channel Access ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Channel Access
        </h3>
        <div className="flex flex-col divide-y divide-border/30">
          <div className="py-3">
            <p className="text-xs font-medium text-foreground">Access control</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Configure access control for messaging channels.
            </p>
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              Channel policies can be configured per-integration from the canvas.
            </p>
          </div>
        </div>
      </section>

      {/* ─── Media Pipeline ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Media Pipeline
        </h3>
        <div className="flex flex-col divide-y divide-border/30">
          <div className="py-3">
            <p className="text-xs font-medium text-foreground">Media processing</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Configure media processing capabilities.
            </p>
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              Media pipeline settings coming soon.
            </p>
          </div>
        </div>
      </section>

      {/* ─── Code Sandbox ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Code Sandbox
        </h3>
        {sandboxConfig ? (
          <div className="flex flex-col divide-y divide-border/30">
            {/* Enable / disable */}
            <div className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-foreground">Enable sandbox</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Run code in isolated Docker containers
                  </p>
                </div>
                <Toggle
                  checked={sandboxConfig.enabled}
                  onChange={() => handleSandboxUpdate({ enabled: !sandboxConfig.enabled })}
                  label="Toggle code sandbox"
                />
              </div>
            </div>

            {sandboxConfig.enabled && (
              <>
                {/* Docker status */}
                <div className="py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-foreground">Docker status</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {sandboxStatus
                          ? sandboxStatus.dockerAvailable
                            ? `Docker running \u2014 ${sandboxStatus.imagesAvailable.length} image(s) ready`
                            : "Docker not available"
                          : "Checking..."}
                      </p>
                    </div>
                    {sandboxStatus && (
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          sandboxStatus.dockerAvailable ? "bg-green-500" : "bg-red-500"
                        }`}
                        aria-label={sandboxStatus.dockerAvailable ? "Docker running" : "Docker offline"}
                      />
                    )}
                  </div>

                  {/* Pull images */}
                  <button
                    onClick={handlePullImages}
                    disabled={pullingImages}
                    className="mt-2 rounded border border-border/40 px-3 py-1.5 text-[10px] font-medium text-foreground hover:bg-white/5 transition-colors disabled:opacity-50"
                  >
                    {pullingImages ? "Pulling..." : "Pull images"}
                  </button>
                </div>

                {/* Resource limits */}
                <div className="py-3">
                  <p className="text-xs font-medium text-foreground mb-2">Resource limits</p>

                  <div className="flex flex-col gap-2.5">
                    {/* Memory limit */}
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] text-muted-foreground">Memory limit</label>
                      <select
                        value={sandboxConfig.memoryLimitMb}
                        onChange={(e) => handleSandboxUpdate({ memoryLimitMb: Number(e.target.value) })}
                        className="rounded border border-input bg-transparent px-2 py-0.5 font-mono text-[10px] text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value={256}>256 MB</option>
                        <option value={512}>512 MB</option>
                        <option value={1024}>1 GB</option>
                        <option value={2048}>2 GB</option>
                        <option value={4096}>4 GB</option>
                      </select>
                    </div>

                    {/* Timeout */}
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] text-muted-foreground">Execution timeout</label>
                      <select
                        value={sandboxConfig.timeoutMs / 1000}
                        onChange={(e) => handleSandboxUpdate({ timeoutMs: Number(e.target.value) * 1000 })}
                        className="rounded border border-input bg-transparent px-2 py-0.5 font-mono text-[10px] text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value={10}>10s</option>
                        <option value={30}>30s</option>
                        <option value={60}>60s</option>
                        <option value={120}>120s</option>
                        <option value={300}>300s</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Network access */}
                <div className="py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-foreground">Network access</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Allow containers to access the network
                      </p>
                    </div>
                    <Toggle
                      checked={!sandboxConfig.networkDisabled}
                      onChange={() => handleSandboxUpdate({ networkDisabled: !sandboxConfig.networkDisabled })}
                      label="Toggle sandbox network access"
                    />
                  </div>
                </div>

                {/* Workspace mount — hidden until safely implemented with path validation */}
              </>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">Loading...</p>
        )}
      </section>
    </div>
  );
}
