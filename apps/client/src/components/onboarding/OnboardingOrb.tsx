import { motion } from "framer-motion";
import { withOpacity } from "@/lib/utils";
import { ORB_EVOLUTIONS } from "./onboarding-variants";

interface Props {
  /** Current evolution level (0 = seed, 5 = radiant) */
  evolution: number;
  /** Override color from personality selection */
  personalityColor?: string;
  /** Trigger the launch burst (scale to fill screen + fade) */
  launching?: boolean;
}

export function OnboardingOrb({ evolution, personalityColor, launching }: Props) {
  const level = Math.min(Math.max(evolution, 0), 5);
  const config = ORB_EVOLUTIONS[level];
  const color = personalityColor ?? config.color;

  return (
    <motion.div
      className="relative flex items-center justify-center"
      animate={
        launching
          ? { scale: 20, opacity: 0 }
          : { width: config.size, height: config.size }
      }
      transition={
        launching
          ? { duration: 0.8, ease: [0.32, 0, 0.67, 0] }
          : { type: "spring", stiffness: 100, damping: 18 }
      }
      style={{ width: config.size, height: config.size }}
    >
      {/* Ambient glow */}
      <motion.div
        className={`absolute rounded-full ${config.animation}`}
        animate={{
          inset: config.glowSpread,
          filter: `blur(${config.glowBlur}px)`,
        }}
        transition={{ duration: 1.2, ease: "easeInOut" }}
        style={{
          background: `radial-gradient(circle, ${withOpacity(color, config.glowAlpha)} 0%, transparent 70%)`,
        }}
      />

      {/* Glass body */}
      <motion.div
        className={`absolute inset-0 rounded-full ${config.animation}`}
        transition={{ duration: 1.2, ease: "easeInOut" }}
        style={{
          background: `linear-gradient(145deg, ${withOpacity(color, config.bodyOpacity)} 0%, ${withOpacity(color, config.bodyOpacity * 0.33)} 50%, ${withOpacity(color, config.bodyOpacity * 0.11)} 100%)`,
          backdropFilter: `blur(${Math.max(6, config.glowBlur)}px) saturate(1.4)`,
          WebkitBackdropFilter: `blur(${Math.max(6, config.glowBlur)}px) saturate(1.4)`,
          border: `1px solid ${withOpacity(color, config.borderOpacity)}`,
          boxShadow: [
            `inset 0 1px 1px ${withOpacity("oklch(1 0 0)", 0.08)}`,
            `0 4px 16px ${withOpacity("oklch(0 0 0)", 0.4)}`,
            `0 0 ${config.glowBlur * 1.5}px ${withOpacity(color, config.glowAlpha * 0.5)}`,
          ].join(", "),
        }}
      />

      {/* Specular highlight */}
      <div
        className="absolute rounded-full"
        style={{
          top: "12%",
          left: "18%",
          width: "40%",
          height: "30%",
          background: `radial-gradient(ellipse at 50% 50%, ${withOpacity("oklch(1 0 0)", config.specularOpacity)} 0%, transparent 70%)`,
          filter: "blur(2px)",
        }}
      />

      {/* Inner color accent */}
      <div
        className="absolute rounded-full"
        style={{
          inset: "25%",
          background: `radial-gradient(circle, ${withOpacity(color, config.bodyOpacity * 0.7)} 0%, transparent 70%)`,
          filter: "blur(3px)",
        }}
      />

      {/* Ripple rings */}
      {Array.from({ length: config.ripples }).map((_, i) => (
        <div
          key={i}
          className="absolute inset-[-10%] rounded-full animate-glass-ripple"
          style={{
            border: `1px solid ${withOpacity(color, 0.15)}`,
            animationDelay: `${i * 1.2}s`,
          }}
        />
      ))}
    </motion.div>
  );
}
