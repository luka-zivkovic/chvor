import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCanvasStore } from "../../stores/canvas-store";
import { usePersonaStore } from "../../stores/persona-store";
import { useModelsStore } from "../../stores/models-store";
import { useCredentialStore } from "../../stores/credential-store";
import { useUIStore } from "../../stores/ui-store";
import { ModelsPanel } from "./ModelsPanel";
import { MemoryInsightsDashboard } from "../memory/MemoryInsightsDashboard";
import { PersonaPanel } from "./PersonaPanel";
import { cn } from "@/lib/utils";
import { api } from "../../lib/api";
import type { BrainTab } from "../../stores/ui-store";
import type { BrainNodeData } from "../../stores/canvas-store";

const TABS: { id: BrainTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "persona", label: "Persona" },
  { id: "memory", label: "Memory" },
];

/* ─── Reusable toggle switch ─── */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200",
        checked ? "bg-primary" : "bg-muted-foreground/25"
      )}
    >
      <span className={cn(
        "pointer-events-none block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200",
        checked ? "translate-x-[14px]" : "translate-x-[2px]"
      )} />
    </button>
  );
}

function BrainConfigContent() {
  const { persona, fetchPersona } = usePersonaStore();
  const { roles, fetchConfig } = useModelsStore();
  const { llmProviders } = useCredentialStore();
  const nodes = useCanvasStore((s) => s.nodes);
  const [maxToolRounds, setMaxToolRounds] = useState(30);
  const [memoryBatchSize, setMemoryBatchSize] = useState(3);
  const [lowTokenMode, setLowTokenMode] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const memoryDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const brainNode = nodes.find((n) => n.type === "brain");
  const data = brainNode?.data as unknown as BrainNodeData | undefined;

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (!persona) fetchPersona();
  }, [persona, fetchPersona]);

  useEffect(() => {
    api.brainConfig.get().then((cfg) => {
      setMaxToolRounds(cfg.maxToolRounds);
      setMemoryBatchSize(cfg.memoryBatchSize);
      setLowTokenMode(cfg.lowTokenMode ?? false);
    }).catch((err) => console.error("[brain] failed to load brain config:", err));
  }, []);

  const primaryConfig = roles.primary;
  const providerDef = llmProviders.find((p) => p.id === primaryConfig?.providerId);
  const modelDef = providerDef?.models.find((m) => m.id === primaryConfig?.model);

  // Self-Healing state
  const [selfHealingEnabled, setSelfHealingEnabled] = useState(false);
  const [healingStatus, setHealingStatus] = useState<{ errors24h: number; lastRepairAt: string | null } | null>(null);

  // Extended Thinking state
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState(10000);

  useEffect(() => {
    api.llmConfig.getThinking().then((cfg) => {
      setThinkingEnabled(cfg.enabled);
      setThinkingBudget(cfg.budgetTokens);
    }).catch(() => toast.error("Failed to load thinking config"));
  }, []);

  useEffect(() => {
    api.brainConfig.getSelfHealing().then((r) => setSelfHealingEnabled(r.enabled)).catch(() => toast.error("Failed to load self-healing status"));
    api.brainConfig.getSelfHealingStatus().then(setHealingStatus).catch(() => {});
  }, []);

  const handleSelfHealingToggle = async () => {
    const next = !selfHealingEnabled;
    setSelfHealingEnabled(next);
    try {
      await api.brainConfig.updateSelfHealing(next);
      if (next) {
        api.brainConfig.getSelfHealingStatus().then(setHealingStatus).catch(() => {});
      }
    } catch {
      setSelfHealingEnabled(!next);
      toast.error("Failed to toggle self-healing");
    }
  };

  const handleThinkingToggle = async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(next);
    try {
      const result = await api.llmConfig.setThinking({ enabled: next, budgetTokens: thinkingBudget });
      setThinkingEnabled(result.enabled);
      setThinkingBudget(result.budgetTokens);
    } catch (err) {
      setThinkingEnabled(!next);
      console.error("[brain] failed to toggle thinking:", err);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      {/* ─── Model ─── */}
      {primaryConfig ? (
        <section>
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-foreground">
                {providerDef?.name ?? primaryConfig.providerId}
              </span>
              <span className="text-xs text-muted-foreground">
                {modelDef?.name ?? primaryConfig.model}
              </span>
            </div>
            {data && (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  data.executionStatus === "running" ? "bg-status-running animate-pulse" :
                  data.executionStatus === "completed" ? "bg-status-completed" :
                  data.executionStatus === "failed" ? "bg-destructive" :
                  "bg-muted-foreground/40"
                )} />
                {data.executionStatus}
              </span>
            )}
          </div>
          {modelDef && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {(modelDef.contextWindow / 1000).toFixed(0)}k context
            </p>
          )}
          <button
            onClick={() => useUIStore.getState().setBrainTab("models")}
            className="mt-1.5 text-[10px] text-primary hover:underline"
          >
            Change model →
          </button>
        </section>
      ) : (
        <section className="rounded-lg border border-status-warning/30 p-3">
          <p className="text-xs font-medium text-status-warning">No LLM configured</p>
          <button
            onClick={() => useUIStore.getState().openPanel("settings")}
            className="mt-1 text-[10px] text-primary hover:underline"
          >
            Add a provider key →
          </button>
        </section>
      )}

      {/* ─── Behavior ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Behavior
        </h3>
        <div className="flex flex-col divide-y divide-border/30">
          {/* Extended Thinking — Anthropic only */}
          {primaryConfig?.providerId === "anthropic" && (
            <div className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-foreground">Extended thinking</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Deep reasoning for complex problems
                  </p>
                </div>
                <Toggle checked={thinkingEnabled} onChange={handleThinkingToggle} label="Toggle extended thinking" />
              </div>
              {thinkingEnabled && (
                <select
                  value={thinkingBudget}
                  onChange={async (e) => {
                    const budget = parseInt(e.target.value, 10);
                    const prev = thinkingBudget;
                    setThinkingBudget(budget);
                    try {
                      await api.llmConfig.setThinking({ enabled: true, budgetTokens: budget });
                    } catch (err) {
                      setThinkingBudget(prev);
                      console.error("[brain] failed to set thinking budget:", err);
                    }
                  }}
                  className="mt-2 w-full rounded border border-border/40 bg-transparent px-2 py-1.5 text-[11px] text-foreground"
                >
                  <option value={5000}>5k tokens — fast</option>
                  <option value={10000}>10k tokens — balanced</option>
                  <option value={25000}>25k tokens — thorough</option>
                  <option value={50000}>50k tokens — deep</option>
                </select>
              )}
            </div>
          )}

          {/* Emotional Awareness */}
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-xs font-medium text-foreground">Emotions</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                Express emotional state on canvas
              </p>
            </div>
            <Toggle
              checked={persona?.emotionsEnabled ?? false}
              onChange={() => {
                const next = !(persona?.emotionsEnabled ?? false);
                usePersonaStore.getState().updatePersona({ emotionsEnabled: next });
              }}
              label="Toggle emotions"
            />
          </div>

          {/* Advanced Emotions (only visible when emotions are enabled) */}
          {(persona?.emotionsEnabled ?? false) && (
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="text-xs font-medium text-foreground">Advanced emotions</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Deep emotional modeling — mood, memory bleed, fatigue
                </p>
                <p className="mt-0.5 text-[10px] text-amber-500/80">
                  Experimental · ~100 extra tokens/turn
                </p>
              </div>
              <Toggle
                checked={persona?.advancedEmotionsEnabled ?? false}
                onChange={() => {
                  const next = !(persona?.advancedEmotionsEnabled ?? false);
                  usePersonaStore.getState().updatePersona({ advancedEmotionsEnabled: next });
                }}
                label="Toggle advanced emotions"
              />
            </div>
          )}

          {/* Self-Healing */}
          <div className="pt-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">Self-healing</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Auto-diagnose and repair broken tools
                </p>
              </div>
              <Toggle checked={selfHealingEnabled} onChange={handleSelfHealingToggle} label="Toggle self-healing" />
            </div>
            {selfHealingEnabled && healingStatus && (
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {healingStatus.errors24h} errors (24h)
                {healingStatus.lastRepairAt && (
                  <> · Last repair {new Date(healingStatus.lastRepairAt).toLocaleDateString()}</>
                )}
              </p>
            )}
          </div>

        </div>
      </section>

      {/* ─── Limits ─── */}
      <section>
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Limits
        </h3>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="text-xs text-foreground">Tool rounds per turn</label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxToolRounds}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 30;
                const clamped = Math.max(1, Math.min(100, val));
                setMaxToolRounds(clamped);
                clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(() => {
                  api.brainConfig.update({ maxToolRounds: clamped }).catch((err) =>
                    console.error("[brain] failed to update max tool rounds:", err)
                  );
                }, 500);
              }}
              className="w-14 rounded border border-border/40 bg-transparent px-2 py-1 text-center text-xs text-foreground tabular-nums"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-foreground">Memory extraction interval</label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={20}
                value={memoryBatchSize}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10) || 3;
                  const clamped = Math.max(1, Math.min(20, val));
                  setMemoryBatchSize(clamped);
                  clearTimeout(memoryDebounceRef.current);
                  memoryDebounceRef.current = setTimeout(() => {
                    api.brainConfig.update({ memoryBatchSize: clamped }).catch((err) =>
                      console.error("[brain] failed to update memory batch size:", err)
                    );
                  }, 500);
                }}
                className="w-14 rounded border border-border/40 bg-transparent px-2 py-1 text-center text-xs text-foreground tabular-nums"
              />
              <span className="text-[10px] text-muted-foreground">turns</span>
            </div>
          </div>

          {/* Low-token mode toggle */}
          <div className="mt-3 flex items-center justify-between border-t border-border/30 pt-3">
            <div>
              <span className="text-xs text-foreground">Low-Token Mode</span>
              <p className="text-[10px] text-muted-foreground">
                Reduces LLM usage: fewer extractions, lighter consolidation
              </p>
            </div>
            <Toggle
              checked={lowTokenMode}
              onChange={async () => {
                const next = !lowTokenMode;
                setLowTokenMode(next);
                try {
                  await api.brainConfig.update({ lowTokenMode: next });
                } catch {
                  setLowTokenMode(!next);
                }
              }}
              label="Toggle low-token mode"
            />
          </div>
        </div>
      </section>

      {/* ─── Personality ─── */}
      {persona && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Personality
          </h3>
          <p className="line-clamp-3 text-xs leading-relaxed text-foreground/70">
            {persona.profile || "No profile set"}
          </p>
          {(persona.tone || persona.communicationStyle) && (
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              {persona.tone && <>{persona.tone}</>}
              {persona.tone && persona.communicationStyle && " · "}
              {persona.communicationStyle && <span className="capitalize">{persona.communicationStyle}</span>}
            </p>
          )}
          <button
            onClick={() => useUIStore.getState().setBrainTab("persona")}
            className="mt-1.5 text-[10px] text-primary hover:underline"
          >
            Edit personality →
          </button>
        </section>
      )}
    </div>
  );
}

export function BrainPanel() {
  const brainTab = useUIStore((s) => s.brainTab);
  const setBrainTab = useUIStore((s) => s.setBrainTab);

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-border/50">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setBrainTab(tab.id)}
            className={cn(
              "flex-1 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] transition-colors",
              brainTab === tab.id
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-5">
        {brainTab === "overview" && <BrainConfigContent />}
        {brainTab === "models" && <ModelsPanel />}
        {brainTab === "persona" && <PersonaPanel />}
        {brainTab === "memory" && <MemoryInsightsDashboard />}
      </div>
    </div>
  );
}
