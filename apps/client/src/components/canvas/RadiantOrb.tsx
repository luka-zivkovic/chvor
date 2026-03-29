import { withOpacity } from "@/lib/utils";

/**
 * RadiantOrb — Volumetric glass orb for hub nodes.
 * Apple-inspired frosted glass with inner light, soft shadow, and subtle refraction.
 */
export function RadiantOrb({
  color,
  size = 72,
  intensity = 0.5,
  animate = true,
  emotionTint,
  children,
}: {
  color: string;
  size?: number;
  intensity?: number;
  animate?: boolean;
  emotionTint?: string | null;
  children?: React.ReactNode;
}) {
  const glowAlpha = 0.12 + intensity * 0.1;

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Ambient glow beneath the glass */}
      <div
        className={`absolute inset-[-20%] rounded-full ${animate ? "animate-glass-breathe" : ""}`}
        style={{
          background: `radial-gradient(circle, ${withOpacity(color, glowAlpha)} 0%, transparent 70%)`,
          filter: "blur(10px)",
        }}
      />
      {/* Glass body */}
      <div
        className={`absolute inset-0 rounded-full ${animate ? "animate-glass-float" : ""}`}
        style={{
          background: `linear-gradient(145deg, ${withOpacity(color, 0.18)} 0%, ${withOpacity(color, 0.06)} 50%, ${withOpacity(color, 0.02)} 100%)`,
          backdropFilter: "blur(12px) saturate(1.4)",
          WebkitBackdropFilter: "blur(12px) saturate(1.4)",
          border: `1px solid ${withOpacity(color, 0.2)}`,
          boxShadow: [
            `inset 0 1px 1px ${withOpacity("oklch(1 0 0)", 0.08)}`,
            `0 4px 16px ${withOpacity("oklch(0 0 0)", 0.4)}`,
            `0 0 20px ${withOpacity(color, glowAlpha * 0.5)}`,
          ].join(", "),
        }}
      />
      {/* Specular highlight — top-left light catch */}
      <div
        className="absolute rounded-full"
        style={{
          top: "12%", left: "18%",
          width: "40%", height: "30%",
          background: `radial-gradient(ellipse at 50% 50%, ${withOpacity("oklch(1 0 0)", 0.12)} 0%, transparent 70%)`,
          filter: "blur(2px)",
        }}
      />
      {/* Inner color accent — subtle tinted center */}
      <div
        className="absolute rounded-full"
        style={{
          inset: "25%",
          background: `radial-gradient(circle, ${withOpacity(color, 0.15)} 0%, transparent 70%)`,
          filter: "blur(3px)",
        }}
      />
      {/* Emotion tint — subtle outer glow in current emotion color */}
      {emotionTint && (
        <div
          className="absolute inset-[-10%] rounded-full"
          style={{
            background: `radial-gradient(circle, ${withOpacity(emotionTint, 0.08)} 0%, transparent 70%)`,
            filter: "blur(8px)",
            transition: "background 2s ease",
          }}
        />
      )}
      {/* Icon overlay */}
      {children && (
        <div className="relative z-10 flex items-center justify-center" style={{ width: size * 0.45, height: size * 0.45 }}>
          {children}
        </div>
      )}
    </div>
  );
}
