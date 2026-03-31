import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { PcSafetyLevel, ShellApprovalMode } from "@chvor/shared";

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

export function PermissionsPanel() {
  // PC Control state
  const [pcEnabled, setPcEnabled] = useState(false);
  const [pcSafetyLevel, setPcSafetyLevel] = useState<PcSafetyLevel>("supervised");
  const [pcLocalAvailable, setPcLocalAvailable] = useState(false);

  // Shell Commands state
  const [shellApprovalMode, setShellApprovalMode] = useState<ShellApprovalMode>("dangerous_only");

  // Network state
  const [allowLocalhost, setAllowLocalhost] = useState(false);

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
      .then((cfg) => {
        setShellApprovalMode(cfg.approvalMode);
      })
      .catch(() => {});

    api.securityConfig
      .get()
      .then((cfg) => {
        setAllowLocalhost(cfg.allowLocalhost);
      })
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
                  <option value="supervised">Supervised — approve every action</option>
                  <option value="semi-autonomous">Semi-autonomous — auto-approve safe actions</option>
                  <option value="autonomous">Autonomous — no approval needed</option>
                </select>
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
              <option value="always_approve">Always approve — run any command</option>
              <option value="dangerous_only">Block dangerous — block rm, sudo, etc.</option>
              <option value="moderate_plus">Block moderate + dangerous — block most writes</option>
              <option value="block_all">Block all — no shell commands</option>
            </select>
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
    </div>
  );
}
