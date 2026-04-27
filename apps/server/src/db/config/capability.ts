import { getConfig, setConfig } from "./base.ts";

// --- Capability enabled/disabled ---

export function isCapabilityEnabled(kind: "skill" | "tool", id: string, defaultEnabled?: boolean): boolean {
  const val = getConfig(`${kind}.enabled.${id}`);
  if (val === undefined || val === null) {
    return defaultEnabled !== false;
  }
  return val !== "false";
}

export function setCapabilityEnabled(kind: "skill" | "tool", id: string, enabled: boolean): boolean {
  setConfig(`${kind}.enabled.${id}`, String(enabled));
  return enabled;
}

// --- Extended Thinking ---

export interface ExtendedThinkingConfig {
  enabled: boolean;
  budgetTokens: number;
}

export function getExtendedThinking(): ExtendedThinkingConfig {
  return {
    enabled: (getConfig("thinking.enabled") ?? "false") === "true",
    budgetTokens: Math.max(1000, Math.min(100000,
      parseInt(getConfig("thinking.budgetTokens") ?? "10000", 10)
    )),
  };
}

export function setExtendedThinking(enabled: boolean, budgetTokens?: number): ExtendedThinkingConfig {
  setConfig("thinking.enabled", String(enabled));
  if (budgetTokens !== undefined) {
    const clamped = Math.max(1000, Math.min(100000, budgetTokens));
    setConfig("thinking.budgetTokens", String(clamped));
  }
  return getExtendedThinking();
}
