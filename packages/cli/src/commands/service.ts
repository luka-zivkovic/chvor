import { realpathSync } from "node:fs";
import { isOnboarded } from "../lib/config.js";

interface ServiceModule {
  install(nodePath: string, cliPath: string, instanceName?: string): Promise<void>;
  uninstall(instanceName?: string): Promise<void>;
  status(instanceName?: string): Promise<void>;
}

async function getPlatformModule(): Promise<ServiceModule> {
  switch (process.platform) {
    case "darwin":
      return import("../lib/service-darwin.js");
    case "linux":
      return import("../lib/service-linux.js");
    case "win32":
      return import("../lib/service-win32.js");
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function resolveExecPaths(): { nodePath: string; cliPath: string } {
  const nodePath = process.execPath;
  const cliPath = realpathSync(process.argv[1]);
  return { nodePath, cliPath };
}

export async function serviceInstall(opts: { instance?: string }): Promise<void> {
  if (!isOnboarded()) {
    console.error("Run `chvor onboard` first.");
    process.exit(1);
  }

  const mod = await getPlatformModule();
  const { nodePath, cliPath } = resolveExecPaths();
  await mod.install(nodePath, cliPath, opts.instance);
}

export async function serviceUninstall(opts: { instance?: string }): Promise<void> {
  const mod = await getPlatformModule();
  await mod.uninstall(opts.instance);
}

export async function serviceStatus(opts: { instance?: string }): Promise<void> {
  const mod = await getPlatformModule();
  await mod.status(opts.instance);
}
