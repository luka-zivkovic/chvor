import { withOpacity } from "@/lib/utils";

/**
 * RadiantField — Volumetric glass pill for leaf nodes.
 * Apple-inspired frosted glass with icon overlay, soft shadow, and specular highlight.
 */
export function RadiantField({
  color,
  size = 72,
  intensity = 0.4,
  animate = true,
  children,
}: {
  color: string;
  size?: number;
  intensity?: number;
  animate?: boolean;
  children?: React.ReactNode;
}) {
  const glowAlpha = 0.1 + intensity * 0.08;

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Ambient glow beneath glass */}
      <div
        className={`absolute inset-[-15%] rounded-full ${animate ? "animate-glass-breathe" : ""}`}
        style={{
          background: `radial-gradient(circle, ${withOpacity(color, glowAlpha)} 0%, transparent 70%)`,
          filter: "blur(8px)",
        }}
      />
      {/* Glass body */}
      <div
        className={`absolute inset-0 rounded-full ${animate ? "animate-glass-float" : ""}`}
        style={{
          background: `linear-gradient(145deg, ${withOpacity(color, 0.16)} 0%, ${withOpacity(color, 0.05)} 50%, ${withOpacity(color, 0.01)} 100%)`,
          backdropFilter: "blur(10px) saturate(1.3)",
          WebkitBackdropFilter: "blur(10px) saturate(1.3)",
          border: `1px solid ${withOpacity(color, 0.18)}`,
          boxShadow: [
            `inset 0 1px 1px ${withOpacity("oklch(1 0 0)", 0.07)}`,
            `0 3px 12px ${withOpacity("oklch(0 0 0)", 0.35)}`,
            `0 0 14px ${withOpacity(color, glowAlpha * 0.4)}`,
          ].join(", "),
        }}
      />
      {/* Specular highlight */}
      <div
        className="absolute rounded-full"
        style={{
          top: "10%", left: "16%",
          width: "38%", height: "28%",
          background: `radial-gradient(ellipse at 50% 50%, ${withOpacity("oklch(1 0 0)", 0.1)} 0%, transparent 70%)`,
          filter: "blur(1.5px)",
        }}
      />
      {/* Icon overlay */}
      {children && (
        <div className="relative z-10 flex items-center justify-center" style={{ width: size * 0.4, height: size * 0.4 }}>
          {children}
        </div>
      )}
    </div>
  );
}
