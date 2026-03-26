import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Create a color with opacity from a CSS variable using color-mix.
 * Usage: withOpacity('var(--canvas-accent)', 0.35)
 * → "color-mix(in oklch, var(--canvas-accent) 35%, transparent)"
 */
export function withOpacity(cssVar: string, opacity: number): string {
  return `color-mix(in oklch, ${cssVar} ${Math.round(opacity * 100)}%, transparent)`;
}
