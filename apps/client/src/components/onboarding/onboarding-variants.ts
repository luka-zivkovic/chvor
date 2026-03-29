import type { Variants } from "framer-motion";

/** Phase panel slide transitions — direction: 1 = forward, -1 = back */
export const phaseVariants: Variants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 80 : -80,
    opacity: 0,
    filter: "blur(4px)",
  }),
  center: {
    x: 0,
    opacity: 1,
    filter: "blur(0px)",
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] },
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -80 : 80,
    opacity: 0,
    filter: "blur(4px)",
    transition: { duration: 0.3, ease: [0.25, 1, 0.5, 1] },
  }),
};

/** Container for staggered children (form fields, skill cards) */
export const staggerContainer: Variants = {
  enter: {},
  center: {
    transition: { staggerChildren: 0.06, delayChildren: 0.15 },
  },
};

/** Individual staggered item */
export const staggerItem: Variants = {
  enter: { y: 16, opacity: 0 },
  center: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.4, ease: "easeOut" },
  },
};

/** Orb size/glow configs per evolution level */
export const ORB_EVOLUTIONS = [
  // Phase 0: Seed
  {
    size: 80,
    color: "oklch(0.35 0.04 30)",
    glowAlpha: 0.04,
    glowBlur: 6,
    glowSpread: "-8%",
    bodyOpacity: 0.04,
    borderOpacity: 0.06,
    specularOpacity: 0.02,
    animation: "animate-onboard-ember",
    ripples: 0,
  },
  // Phase 1: Spark
  {
    size: 120,
    color: "oklch(0.45 0.08 250)",
    glowAlpha: 0.08,
    glowBlur: 10,
    glowSpread: "-15%",
    bodyOpacity: 0.10,
    borderOpacity: 0.12,
    specularOpacity: 0.06,
    animation: "animate-glass-float",
    ripples: 0,
  },
  // Phase 2: Pulse
  {
    size: 140,
    color: "oklch(0.55 0.11 250)",
    glowAlpha: 0.14,
    glowBlur: 14,
    glowSpread: "-20%",
    bodyOpacity: 0.18,
    borderOpacity: 0.18,
    specularOpacity: 0.10,
    animation: "animate-glass-breathe",
    ripples: 0,
  },
  // Phase 3: Identity (color overridden by personality)
  {
    size: 160,
    color: "oklch(0.62 0.13 250)",
    glowAlpha: 0.18,
    glowBlur: 18,
    glowSpread: "-25%",
    bodyOpacity: 0.22,
    borderOpacity: 0.22,
    specularOpacity: 0.12,
    animation: "animate-glass-float",
    ripples: 0,
  },
  // Phase 4: Power
  {
    size: 180,
    color: "oklch(0.62 0.13 250)",
    glowAlpha: 0.22,
    glowBlur: 22,
    glowSpread: "-35%",
    bodyOpacity: 0.28,
    borderOpacity: 0.28,
    specularOpacity: 0.14,
    animation: "animate-glass-breathe",
    ripples: 1,
  },
  // Phase 5: Radiant
  {
    size: 200,
    color: "oklch(0.62 0.13 250)",
    glowAlpha: 0.30,
    glowBlur: 30,
    glowSpread: "-45%",
    bodyOpacity: 0.35,
    borderOpacity: 0.40,
    specularOpacity: 0.18,
    animation: "animate-glass-pulse",
    ripples: 2,
  },
] as const;

/** Personality tag → orb color */
export const PERSONALITY_COLORS: Record<string, string> = {
  fun: "oklch(0.65 0.18 50)",
  productivity: "oklch(0.65 0.15 160)",
  balanced: "oklch(0.62 0.13 250)",
  custom: "oklch(0.60 0.15 280)",
};
