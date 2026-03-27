import { spawn, execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  openSync,
} from "node:fs";
import { join } from "node:path";

import {
  getAppDir,
  getDataDir,
  getLogsDir,
  getPidPath,
  getSkillsDir,
  getToolsDir,
  ensureDir,
} from "./paths.js";
import { readConfig } from "./config.js";

interface ServerStatus {
  running: boolean;
  pid?: number;
}

function isProcessAlive(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.includes(String(pid));
    } catch {
      return false;
    }
  } else {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export function isServerRunning(): ServerStatus {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) {
    return { running: false };
  }

  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) {
      return { running: false };
    }

    if (isProcessAlive(pid)) {
      return { running: true, pid };
    }

    // Stale PID file — clean up
    unlinkSync(pidPath);
    return { running: false };
  } catch {
    return { running: false };
  }
}

interface SpawnOptions {
  port?: string;
  foreground?: boolean;
}

export async function spawnServer(opts: SpawnOptions = {}): Promise<void> {
  const config = readConfig();
  const port = opts.port ?? config.port;
  const token = config.token;

  const status = isServerRunning();
  if (status.running) {
    console.log(
      `Chvor is already running (PID ${status.pid}).`
    );
    console.log(`  http://localhost:${port}`);
    return;
  }

  const serverEntry = join(
    getAppDir(),
    "apps",
    "server",
    "src",
    "index.ts"
  );

  if (!existsSync(serverEntry)) {
    throw new Error(
      `Server entry point not found: ${serverEntry}\nRun "chvor install" first.`
    );
  }

  const dataDir = getDataDir();
  ensureDir(dataDir);

  // Build environment variables
  const env: Record<string, string> = {
    ...filterEnv(process.env),
    PORT: port,
    CHVOR_DATA_DIR: dataDir,
    CHVOR_SKILLS_DIR: getSkillsDir(),
    CHVOR_TOOLS_DIR: getToolsDir(),
    NODE_ENV: "production",
  };

  if (token) {
    env.CHVOR_TOKEN = token;
  }

  // Pass through common LLM API key env vars
  const llmKeyVars = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "OPENROUTER_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
  ];
  for (const key of llmKeyVars) {
    if (process.env[key] && !env[key]) {
      env[key] = process.env[key]!;
    }
  }

  if (opts.foreground) {
    console.log(`Starting Chvor on port ${port} (foreground)...`);

    const child = spawn("node", ["--import", "tsx", serverEntry], {
      env,
      cwd: getAppDir(),
      stdio: "inherit",
    });

    if (child.pid === undefined) {
      throw new Error("Failed to spawn server process.");
    }

    const pidPath = getPidPath();
    writeFileSync(pidPath, String(child.pid), { encoding: "utf-8", mode: 0o600 });

    child.on("error", (err) => {
      console.error(`Server process error: ${err.message}`);
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      process.exit(1);
    });

    // Forward SIGTERM/SIGINT to child so service managers (launchd, systemd)
    // see a clean exit(0) instead of 128+signal
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => {
        try { unlinkSync(pidPath); } catch { /* ignore */ }
        child.kill(sig);
      });
    }

    child.on("exit", (code) => {
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore — may already be cleaned up by signal handler
      }
      process.exit(code ?? 1);
    });

    // Wait for health
    const healthy = await pollHealth(port, token);
    if (healthy) {
      console.log(`Chvor is ready at http://localhost:${port}`);
    } else {
      console.warn("Chvor started but health check did not pass within timeout.");
    }
  } else {
    console.log(`Starting Chvor on port ${port} (background)...`);

    const logsDir = getLogsDir();
    ensureDir(logsDir);

    const logPath = join(logsDir, "server.log");
    const logFd = openSync(logPath, "a");

    const child = spawn("node", ["--import", "tsx", serverEntry], {
      env,
      cwd: getAppDir(),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });

    if (child.pid === undefined) {
      throw new Error("Failed to spawn server process.");
    }

    child.unref();

    const pidPath = getPidPath();
    writeFileSync(pidPath, String(child.pid), { encoding: "utf-8", mode: 0o600 });

    console.log(`Chvor started (PID ${child.pid}). Logs: ${logPath}`);

    const healthy = await pollHealth(port, token);
    if (healthy) {
      console.log(`Chvor is ready at http://localhost:${port}`);
    } else {
      console.warn(
        "Chvor started but health check did not pass within timeout.\n" +
          `Check logs at ${logPath}`
      );
    }
  }
}

export async function stopServer(): Promise<void> {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) {
    console.log("Chvor is not running.");
    return;
  }

  const raw = readFileSync(pidPath, "utf-8").trim();
  const pid = parseInt(raw, 10);

  if (isNaN(pid)) {
    console.log("Invalid PID file. Cleaning up.");
    unlinkSync(pidPath);
    return;
  }

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Process may already be gone
  }

  try {
    unlinkSync(pidPath);
  } catch {
    // ignore
  }

  console.log("Chvor stopped.");
}

export async function pollHealth(
  port: string,
  token?: string,
  timeoutMs = 30000,
  intervalMs = 500
): Promise<boolean> {
  const start = Date.now();
  const url = `http://localhost:${port}/api/health`;

  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) {
          return true;
        }
      }
    } catch {
      // Connection refused or other error — server not ready yet
    }

    await sleep(intervalMs);
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function filterEnv(
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
