import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConfigPath, ensureDir } from "./paths.js";

export interface ChvorConfig {
  installedVersion?: string;
  port: string;
  token?: string;
  onboarded: boolean;
  llmProvider?: string;
  instanceName?: string;
  templateName?: string;
}

const DEFAULTS: ChvorConfig = {
  port: "9147",
  onboarded: false,
};

export function readConfig(): ChvorConfig {
  const configPath = getConfigPath();
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ChvorConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(config: ChvorConfig): void {
  const configPath = getConfigPath();
  ensureDir(dirname(configPath));
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
}

export function isOnboarded(): boolean {
  const config = readConfig();
  return config.onboarded && !!config.installedVersion;
}
