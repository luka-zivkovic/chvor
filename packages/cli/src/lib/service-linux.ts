import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

function getServicePath(instance?: string): string {
  const name = instance ? `chvor-${instance}` : "chvor";
  return join(homedir(), ".config", "systemd", "user", `${name}.service`);
}

function getServiceName(instance?: string): string {
  return instance ? `chvor-${instance}.service` : "chvor.service";
}

export async function install(nodePath: string, cliPath: string, instance?: string): Promise<void> {
  const servicePath = getServicePath(instance);
  const serviceName = getServiceName(instance);

  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });

  const args = ["start", "--foreground"];
  if (instance) args.push("-i", instance);

  const unit = `[Unit]
Description=Chvor AI Server${instance ? ` (${instance})` : ""}
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath} ${args.join(" ")}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

  writeFileSync(servicePath, unit, "utf-8");

  execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  execSync(`systemctl --user enable ${serviceName}`, { stdio: "inherit" });
  execSync(`systemctl --user start ${serviceName}`, { stdio: "inherit" });

  console.log(`Auto-start installed. Chvor will start on login.`);
  console.log(`  Service: ${servicePath}`);
}

export async function uninstall(instance?: string): Promise<void> {
  const servicePath = getServicePath(instance);
  const serviceName = getServiceName(instance);

  if (!existsSync(servicePath)) {
    console.log("Auto-start is not installed.");
    return;
  }

  try {
    execSync(`systemctl --user stop ${serviceName}`, { stdio: "pipe" });
  } catch {
    // Already stopped
  }
  try {
    execSync(`systemctl --user disable ${serviceName}`, { stdio: "pipe" });
  } catch {
    // Already disabled
  }

  unlinkSync(servicePath);
  execSync("systemctl --user daemon-reload", { stdio: "pipe" });

  console.log("Auto-start removed.");
}

export async function status(instance?: string): Promise<void> {
  const servicePath = getServicePath(instance);
  const serviceName = getServiceName(instance);

  if (!existsSync(servicePath)) {
    console.log("Auto-start: not installed");
    return;
  }

  try {
    const output = execSync(`systemctl --user is-active ${serviceName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`Auto-start: installed (${output.trim()})`);
    console.log(`  Service: ${servicePath}`);
  } catch {
    console.log("Auto-start: installed (inactive)");
    console.log(`  Service: ${servicePath}`);
  }
}
