import { memo, useMemo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { BrainNodeData } from "../../stores/canvas-store";
import { useAppStore } from "../../stores/app-store";
import { useRuntimeStore } from "../../stores/runtime-store";
import { getBreatheDuration, getGlowSpread } from "../../lib/emotion-colors";
import { useUIStore } from "../../stores/ui-store";
import { withOpacity } from "@/lib/utils";
import { Brain } from "lucide-react";

const V = {
  accent: "var(--canvas-accent)",
  accentDim: "var(--canvas-accent-dim)",
  completed: "var(--status-completed)",
  failed: "var(--status-failed)",
  warning: "var(--status-warning)",
  nodeBgFrom: "var(--node-bg-from)",
  nodeBgTo: "var(--node-bg-to)",
  nodeLabel: "var(--node-label)",
  nodeLabelDim: "var(--node-label-dim)",
};

/** Map mood octants to distinct hue shifts for the aura ring */
const MOOD_HUES: Record<string, string> = {
  exuberant: "oklch(0.72 0.16 85)",    // warm gold
  relaxed: "oklch(0.68 0.10 170)",     // soft teal
  docile: "oklch(0.60 0.08 220)",      // cool blue
  dependent: "oklch(0.55 0.12 280)",   // muted violet
  hostile: "oklch(0.50 0.18 25)",      // deep ember
  anxious: "oklch(0.48 0.14 50)",      // rust
  disdainful: "oklch(0.42 0.10 300)",  // cold purple
  bored: "oklch(0.40 0.04 260)",       // desaturated slate
};

export const BrainNode = memo(function BrainNode({ data }: NodeProps) {
  const d = data as unknown as BrainNodeData;
  const currentEmotion = useAppStore((s) => s.currentEmotion);
  const snapshot = useRuntimeStore((s) => s.currentSnapshot);
  const displayColor = useRuntimeStore((s) => s.displayColor);
  const displayLabel = useRuntimeStore((s) => s.displayLabel);
  const secondaryLabel = useRuntimeStore((s) => s.secondaryLabel);
  const blendIntensity = useRuntimeStore((s) => s.blendIntensity);
  const isSignificantShift = useRuntimeStore((s) => s.isSignificantShift);

  const status = d.executionStatus;
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  const isIdle = !isRunning && !isCompleted && !isFailed;
  const hasNoProvider = !d.providerId && d.model === "No provider";

  const emotionColor = displayColor ?? null;
  const emotionIntensity = blendIntensity || currentEmotion?.intensity || 0;
  const hasEmotion = !!emotionColor || !!currentEmotion;

  // VAD-derived animation parameters
  const breatheDuration = useMemo(() => {
    if (!snapshot?.vad) return 4;
    return getBreatheDuration(snapshot.vad.arousal);
  }, [snapshot?.vad?.arousal]);

  const glowBlur = useMemo(() => {
    if (!snapshot?.vad) return 20;
    return getGlowSpread(snapshot.vad.dominance);
  }, [snapshot?.vad?.dominance]);

  // Advanced emotion data
  const advancedState = snapshot?.advancedState;
  const moodOctant = advancedState?.mood?.octant;
  const energyLevel = advancedState?.embodiment?.energyLevel ?? 1;
  const residues = advancedState?.unresolvedResidues ?? [];
  const moodColor = moodOctant ? MOOD_HUES[moodOctant] ?? null : null;

  // Energy arc: SVG arc stroke-dashoffset controls how much is visible
  const energyCircumference = Math.PI * 2 * 98; // radius 98
  const energyOffset = energyCircumference * (1 - energyLevel);

  let fieldColor: string;
  if (isRunning) fieldColor = V.accent;
  else if (isCompleted) fieldColor = V.completed;
  else if (isFailed) fieldColor = V.failed;
  else if (hasNoProvider) fieldColor = V.warning;
  else if (emotionColor) fieldColor = emotionColor;
  else fieldColor = V.accent;

  const glassAnim = isRunning ? "animate-glass-pulse" : isCompleted ? "animate-glass-settle" : "animate-glass-float";
  const glowAnim = isRunning ? "animate-glass-pulse" : "animate-glass-breathe";
  const glowAlpha = isRunning ? 0.55 : isCompleted ? 0.2 : isFailed ? 0.18 : 0.14 + emotionIntensity * 0.08;

  const primaryLabel = displayLabel || currentEmotion?.emotion || "";
  const showEmotionLabels = isIdle && hasEmotion && primaryLabel;

  return (
    <>
      <div className="relative flex flex-col items-center" style={{ color: V.accent }}>
        {/* ── Mood aura ring: slow-rotating outer glow representing medium-term mood ── */}
        {moodColor && isIdle && (
          <div
            className="animate-mood-aura pointer-events-none absolute"
            style={{
              width: 220, height: 220,
              top: -20, left: "50%", marginLeft: -110,
            }}
          >
            <div
              className="animate-mood-aura-breathe absolute inset-0 rounded-full"
              style={{
                "--aura-alpha": 0.06 + emotionIntensity * 0.06,
                background: `conic-gradient(from 0deg, ${withOpacity(moodColor, 0.12)}, transparent 40%, ${withOpacity(moodColor, 0.08)} 60%, transparent 80%, ${withOpacity(moodColor, 0.1)})`,
                filter: "blur(12px)",
              } as React.CSSProperties}
            />
          </div>
        )}

        {/* ── Energy arc: thin SVG ring that depletes as energy drops ── */}
        {advancedState && isIdle && (
          <svg
            className="animate-energy-arc pointer-events-none absolute"
            width="200" height="200"
            style={{ top: -10, left: "50%", marginLeft: -100 }}
            viewBox="0 0 200 200"
          >
            {/* Track (faint background ring) */}
            <circle
              cx="100" cy="100" r="98"
              fill="none"
              stroke={withOpacity(fieldColor, 0.04)}
              strokeWidth="1"
            />
            {/* Energy level (depleting arc) */}
            <circle
              cx="100" cy="100" r="98"
              fill="none"
              stroke={withOpacity(fieldColor, 0.15 + energyLevel * 0.15)}
              strokeWidth={energyLevel > 0.3 ? 1.5 : 1}
              strokeDasharray={energyCircumference}
              strokeDashoffset={energyOffset}
              strokeLinecap="round"
              transform="rotate(-90 100 100)"
              style={{ transition: "stroke-dashoffset 2s ease-out, stroke 1.5s ease" }}
            />
          </svg>
        )}

        {/* ── Residue traces: faint persistent glow spots for unresolved emotions ── */}
        {residues.length > 0 && isIdle && residues.slice(0, 4).map((residue, i) => {
          const angle = -Math.PI / 2 + (i / Math.max(residues.length, 1)) * Math.PI * 2;
          const rx = Math.cos(angle) * 70;
          const ry = Math.sin(angle) * 70;
          return (
            <div
              key={residue.id ?? i}
              className="animate-residue-pulse pointer-events-none absolute rounded-full"
              style={{
                width: 8 + residue.intensity * 8,
                height: 8 + residue.intensity * 8,
                top: 90 + ry - 4,
                left: "50%",
                marginLeft: rx - 4,
                background: `radial-gradient(circle, ${withOpacity(fieldColor, 0.3 * residue.intensity)} 0%, transparent 70%)`,
                filter: "blur(3px)",
                animationDelay: `${i * 1.1}s`,
                animationDuration: `${3 + i * 0.7}s`,
              }}
            />
          );
        })}

        {/* ── Expanding ripple rings (running only) ── */}
        {isRunning && (
          <>
            <div
              className="animate-glass-ripple pointer-events-none absolute rounded-full"
              style={{
                width: 180, height: 180,
                top: 0, left: "50%", marginLeft: -90,
                border: `1px solid ${withOpacity(fieldColor, 0.25)}`,
              }}
            />
            <div
              className="animate-glass-ripple pointer-events-none absolute rounded-full"
              style={{
                width: 180, height: 180,
                top: 0, left: "50%", marginLeft: -90,
                border: `1px solid ${withOpacity(fieldColor, 0.15)}`,
                animationDelay: "1.2s",
              }}
            />
          </>
        )}

        {/* ── Emotion shift ripple (one-shot on significant shifts) ── */}
        {isSignificantShift && emotionColor && (
          <div
            className="animate-emotion-shift pointer-events-none absolute rounded-full"
            style={{
              width: 180, height: 180,
              top: 0, left: "50%", marginLeft: -90,
              border: `2px solid ${emotionColor}`,
            }}
          />
        )}

        {/* ── Glass sphere container ── */}
        <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>
          {/* Ambient glow — breathing modulates spread depth, not just speed */}
          <div
            className={`absolute rounded-full transition-all duration-1000 ${glowAnim}`}
            style={{
              inset: isRunning ? "-45%" : "-20%",
              "--glow-blur": `${glowBlur}px`,
              background: `radial-gradient(circle, ${withOpacity(fieldColor, glowAlpha)} 0%, ${withOpacity(fieldColor, glowAlpha * 0.3)} 40%, transparent 70%)`,
              filter: isRunning ? "blur(24px)" : `blur(${glowBlur}px)`,
              animation: isIdle
                ? `glow-depth-breathe ${breatheDuration * 1.2}s ease-in-out infinite`
                : undefined,
            } as React.CSSProperties}
          />

          {/* Extra bloom layer — visible only when running */}
          {isRunning && (
            <div
              className="absolute inset-[-60%] rounded-full animate-glass-breathe"
              style={{
                background: `radial-gradient(circle, ${withOpacity(fieldColor, 0.2)} 0%, transparent 60%)`,
                filter: "blur(30px)",
              }}
            />
          )}

          {/* Glass body — main frosted sphere */}
          <div
            className={`absolute inset-0 rounded-full transition-all duration-700 ${glassAnim}`}
            style={{
              background: isRunning
                ? `linear-gradient(145deg, ${withOpacity(fieldColor, 0.35)} 0%, ${withOpacity(fieldColor, 0.18)} 40%, ${withOpacity(fieldColor, 0.1)} 70%, ${withOpacity(fieldColor, 0.15)} 100%)`
                : `linear-gradient(145deg, ${withOpacity(fieldColor, 0.2)} 0%, ${withOpacity(fieldColor, 0.08)} 40%, ${withOpacity(fieldColor, 0.03)} 70%, ${withOpacity(fieldColor, 0.06)} 100%)`,
              backdropFilter: "blur(16px) saturate(1.5)",
              WebkitBackdropFilter: "blur(16px) saturate(1.5)",
              border: `1px solid ${withOpacity(fieldColor, isRunning ? 0.4 : 0.22)}`,
              boxShadow: [
                `0 8px 32px ${withOpacity("oklch(0 0 0)", 0.5)}`,
                `0 0 ${isRunning ? 50 : 30}px ${withOpacity(fieldColor, isRunning ? 0.35 : glowAlpha * 0.6)}`,
              ].join(", "),
              animation: isIdle ? `glass-float ${breatheDuration}s ease-in-out infinite` : undefined,
            }}
          />

          {/* Specular highlight */}
          <div
            className="absolute rounded-full"
            style={{
              top: "8%", left: "14%",
              width: "45%", height: "32%",
              background: `radial-gradient(ellipse at 50% 50%, ${withOpacity("oklch(1 0 0)", 0.14)} 0%, ${withOpacity("oklch(1 0 0)", 0.04)} 50%, transparent 70%)`,
              filter: "blur(3px)",
            }}
          />

          {/* Brain icon */}
          <div
            className={`relative z-10 flex items-center justify-center transition-all duration-500 ${isRunning ? "animate-glass-pulse" : ""}`}
            style={{ width: 56, height: 56, opacity: isRunning ? 0.9 : 0.6 }}
          >
            <Brain size={48} stroke={fieldColor} strokeWidth={1.2} />
          </div>
        </div>

        {/* Warning badge (no provider) */}
        {hasNoProvider && !isRunning && (
          <div
            className="absolute -top-1.5 -right-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-status-warning animate-pulse"
            style={{ boxShadow: `0 0 12px ${withOpacity(V.warning, 0.5)}` }}
            title="No LLM provider configured — click to set up"
            onClick={(e) => { e.stopPropagation(); useUIStore.getState().openPanel("brain"); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--background)" strokeWidth="3" strokeLinecap="round">
              <line x1="12" y1="8" x2="12" y2="14" />
              <circle cx="12" cy="18" r="0.5" fill="var(--background)" />
            </svg>
          </div>
        )}

        {/* Label pill */}
        <div className="mt-3 flex flex-col items-center gap-0.5">
          <span
            className="rounded-full px-3 py-0.5 font-mono text-[10px] font-semibold uppercase"
            style={{
              letterSpacing: "0.25em",
              color: fieldColor,
              background: withOpacity(V.nodeBgTo, 0.85),
              border: `1px solid ${withOpacity(fieldColor, 0.15)}`,
            }}
          >
            {d.label}
          </span>
          <span className="text-[8px]" style={{ color: V.nodeLabelDim }}>
            {d.model}
          </span>
          {/* Emotion labels */}
          {showEmotionLabels && (
            <div className="mt-0.5 flex items-center gap-1 font-mono text-[8px] font-medium lowercase transition-all duration-700">
              <span style={{ color: emotionColor ?? V.nodeLabelDim }}>
                {primaryLabel}
              </span>
              {secondaryLabel && (
                <>
                  <span style={{ color: V.nodeLabelDim, opacity: 0.5 }}>.</span>
                  <span style={{ color: emotionColor ?? V.nodeLabelDim, opacity: 0.55 }}>
                    {secondaryLabel}
                  </span>
                </>
              )}
            </div>
          )}
          {/* Advanced: mood octant + energy */}
          {advancedState && isIdle && (
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[7px] lowercase" style={{ color: V.nodeLabelDim, opacity: 0.6 }}>
              <span>{moodOctant}</span>
              <span style={{ opacity: 0.4 }}>/</span>
              <span>{Math.round(energyLevel * 100)}% energy</span>
            </div>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0"
      />
    </>
  );
});
