import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

let currentInstance: string | null = null;

export function setInstance(name: string): void {
  currentInstance = name;
}

export function getInstance(): string | null {
  return currentInstance;
}

export function getChvorHome(): string {
  if (currentInstance) {
    return join(homedir(), `.chvor-${currentInstance}`);
  }
  return join(homedir(), ".chvor");
}

export function getConfigPath(): string {
  return join(getChvorHome(), "config.json");
}

export function getPidPath(): string {
  return join(getChvorHome(), "chvor.pid");
}

export function getAppDir(): string {
  // App binaries are shared across all instances
  return join(homedir(), ".chvor", "app");
}

export function getDataDir(): string {
  return join(getChvorHome(), "data");
}

export function getLogsDir(): string {
  return join(getChvorHome(), "logs");
}

export function getDownloadsDir(): string {
  // Downloads are shared across all instances
  return join(homedir(), ".chvor", "downloads");
}

export function getSkillsDir(): string {
  return join(getChvorHome(), "skills");
}

export function getToolsDir(): string {
  return join(getChvorHome(), "tools");
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
