import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { setInstance } from "../lib/paths.js";
import { readConfig } from "../lib/config.js";
import { isServerRunning, spawnServer, stopServer } from "../lib/process.js";

interface InstanceInfo {
  name: string;
  port: string;
  running: boolean;
  pid?: number;
  template?: string;
}

function discoverInstances(): InstanceInfo[] {
  const home = homedir();
  const instances: InstanceInfo[] = [];

  // Check default instance
  const defaultConfig = join(home, ".chvor", "config.json");
  if (existsSync(defaultConfig)) {
    try {
      const config = JSON.parse(readFileSync(defaultConfig, "utf-8"));
      // Check if running
      const pidPath = join(home, ".chvor", "chvor.pid");
      let running = false;
      let pid: number | undefined;
      if (existsSync(pidPath)) {
        const rawPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        if (!isNaN(rawPid)) {
          try {
            process.kill(rawPid, 0);
            running = true;
            pid = rawPid;
          } catch {
            // not running
          }
        }
      }
      instances.push({
        name: "(default)",
        port: config.port || "9147",
        running,
        pid,
        template: config.templateName,
      });
    } catch (err) {
      console.warn(`  Warning: could not read default instance config: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Scan for named instances (~/.chvor-*/config.json)
  const entries = readdirSync(home, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^\.chvor-(.+)$/);
    if (!match) continue;

    const instanceName = match[1];
    const configPath = join(home, entry.name, "config.json");
    if (!existsSync(configPath)) continue;

    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const pidPath = join(home, entry.name, "chvor.pid");
      let running = false;
      let pid: number | undefined;
      if (existsSync(pidPath)) {
        const rawPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        if (!isNaN(rawPid)) {
          try {
            process.kill(rawPid, 0);
            running = true;
            pid = rawPid;
          } catch {
            // not running
          }
        }
      }
      instances.push({
        name: instanceName,
        port: config.port || "?",
        running,
        pid,
        template: config.templateName,
      });
    } catch (err) {
      console.warn(`  Warning: could not read instance "${instanceName}" config: ${err instanceof Error ? err.message : err}`);
    }
  }

  return instances;
}

export async function listInstances(): Promise<void> {
  const instances = discoverInstances();

  if (instances.length === 0) {
    console.log("  No chvor instances found. Run 'chvor init' to create one.");
    return;
  }

  console.log("\n  Chvor instances:\n");
  console.log(
    "  " +
      "NAME".padEnd(20) +
      "PORT".padEnd(8) +
      "STATUS".padEnd(12) +
      "TEMPLATE"
  );
  console.log("  " + "-".repeat(60));

  for (const inst of instances) {
    const status = inst.running
      ? `running (${inst.pid})`
      : "stopped";
    console.log(
      "  " +
        inst.name.padEnd(20) +
        inst.port.padEnd(8) +
        status.padEnd(12) +
        (inst.template || "-")
    );
  }
  console.log();
}

export async function startInstance(name: string): Promise<void> {
  setInstance(name);
  const config = readConfig();

  if (!config.onboarded) {
    console.log(`Instance "${name}" has not been set up. Run 'chvor init --name ${name}' first.`);
    return;
  }

  const { start } = await import("./start.js");
  await start({});
}

export async function stopInstance(name: string): Promise<void> {
  setInstance(name);
  await stopServer();
}
