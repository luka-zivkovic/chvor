import { usePcStore } from "../../stores/pc-store";
import type { PcSafetyLevel } from "@chvor/shared";

const SAFETY_LABELS: Record<PcSafetyLevel, { label: string; description: string }> = {
  supervised: {
    label: "Supervised",
    description: "Every action requires your approval",
  },
  "semi-autonomous": {
    label: "Semi-autonomous",
    description: "Common actions auto-approved, destructive ones need OK",
  },
  autonomous: {
    label: "Autonomous",
    description: "AI acts freely — watch via the viewer",
  },
};

const LAYER_ICONS: Record<string, { icon: string; label: string }> = {
  "action-router": { icon: "\u26A1", label: "Action Router" },
  "a11y": { icon: "\uD83C\uDF33", label: "Accessibility Tree" },
  "vision": { icon: "\uD83D\uDC41", label: "Vision" },
};

export function PcConnectionPanel() {
  const { enabled, setEnabled, localAvailable, agents, activeAgentId, setActiveAgent, safetyLevel, setSafetyLevel, disconnectAgent, pipelineActivity } = usePcStore();

  return (
    <div className="flex flex-col gap-4">
      {/* Enable/disable toggle */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-white/50 uppercase tracking-wider">
            PC Control
          </h3>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`relative w-8 h-4 rounded-full transition-colors ${
              enabled ? "bg-emerald-500/60" : "bg-white/10"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                enabled ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        <p className="text-[10px] text-white/30 mt-1">
          {enabled ? "AI can see and control PCs" : "Disabled"}
        </p>
      </div>

      {!enabled ? (
        <p className="text-xs text-white/30">Enable PC Control to allow AI to interact with this PC or connected remote PCs.</p>
      ) : (
        <>
          {/* Pipeline activity indicator */}
          {pipelineActivity && (
            <div className="bg-white/5 rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center gap-2 text-white/60">
                <span className="animate-pulse">
                  {LAYER_ICONS[pipelineActivity.layer]?.icon ?? "..."}
                </span>
                <span>{LAYER_ICONS[pipelineActivity.layer]?.label ?? pipelineActivity.layer}</span>
                <span className="text-white/30">
                  {pipelineActivity.status === "trying" ? "analyzing..." : pipelineActivity.status}
                </span>
              </div>
            </div>
          )}

          {/* Available PCs */}
          <div>
            <h3 className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
              Available PCs
            </h3>
            {agents.length === 0 && !localAvailable ? (
              <p className="text-xs text-white/30">No PCs available</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => setActiveAgent(agent.id)}
                    className={`text-left px-3 py-2 rounded-lg text-xs transition-colors group ${
                      agent.id === activeAgentId
                        ? "bg-white/10 text-white"
                        : "text-white/60 hover:bg-white/5 hover:text-white/80"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`h-1.5 w-1.5 rounded-full ${
                          agent.status === "connected" ? "bg-emerald-400" : "bg-red-400"
                        }`} />
                        <span className="font-medium">{agent.hostname}</span>
                        {agent.id === "local" && (
                          <span className="text-[9px] bg-emerald-500/20 text-emerald-400/80 px-1 rounded">local</span>
                        )}
                      </div>
                      {agent.id !== "local" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            disconnectAgent(agent.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all text-[10px]"
                          title="Disconnect"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                    <div className="text-[10px] text-white/40 mt-0.5 ml-3.5">{agent.os}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Safety level */}
          <div>
            <h3 className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
              Safety Level
            </h3>
            <div className="flex flex-col gap-1">
              {(Object.keys(SAFETY_LABELS) as PcSafetyLevel[]).map((level) => (
                <button
                  key={level}
                  onClick={() => setSafetyLevel(level)}
                  className={`text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                    level === safetyLevel
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:bg-white/5 hover:text-white/70"
                  }`}
                >
                  <div className="font-medium">{SAFETY_LABELS[level].label}</div>
                  <div className="text-[10px] text-white/40 mt-0.5">
                    {SAFETY_LABELS[level].description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Add remote PC instructions */}
          <div>
            <h3 className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
              Add Remote PC
            </h3>
            <div className="text-[11px] text-white/40 space-y-1.5">
              <p>Run on the target PC:</p>
              <code className="block bg-white/5 px-2 py-1.5 rounded text-emerald-400/80 font-mono text-[10px] break-all">
                {`npx @chvor/pc-agent --server ws://${window.location.host}/ws/pc-agent`}
              </code>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
