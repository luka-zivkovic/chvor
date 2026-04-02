import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { randomUUID } from "node:crypto";
import { logError } from "./error-logger.ts";
import type { SandboxLanguage, SandboxConfig, SandboxExecutionResult } from "@chvor/shared";

// ─── Docker Connection ─────────────────────────────────────

const DOCKER_SOCKET = process.platform === "win32"
  ? "//./pipe/docker_engine"
  : "/var/run/docker.sock";

const LANGUAGE_IMAGES: Record<SandboxLanguage, string> = {
  python: "python:3.12-slim",
  node: "node:20-slim",
  bash: "bash:5",
};

const CONTAINER_LABEL = "chvor.sandbox";
const API_VERSION = "v1.45";
const MAX_OUTPUT_BYTES = 50_000;

let dockerAvailable = false;
let dockerVersion: string | undefined;

// ─── Public API ────────────────────────────────────────────

export async function initDocker(): Promise<void> {
  try {
    const result = await checkDockerAvailable();
    dockerAvailable = result.available;
    dockerVersion = result.version;
    if (dockerAvailable) {
      console.log(`[sandbox] Docker ${dockerVersion} detected`);
      await cleanupOrphans();
    } else {
      console.log("[sandbox] Docker not available — sandbox execution disabled");
    }
  } catch (err) {
    dockerAvailable = false;
    console.log("[sandbox] Docker detection failed:", err);
  }
}

export function isDockerAvailable(): boolean {
  return dockerAvailable;
}

export function getDockerVersion(): string | undefined {
  return dockerVersion;
}

export async function checkDockerAvailable(): Promise<{ available: boolean; version?: string }> {
  try {
    const res = await dockerRequest("GET", `/${API_VERSION}/version`);
    if (res.status === 200) {
      const body = JSON.parse(res.body.toString());
      return { available: true, version: body.Version };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

export async function listAvailableImages(): Promise<SandboxLanguage[]> {
  const available: SandboxLanguage[] = [];
  for (const [lang, image] of Object.entries(LANGUAGE_IMAGES) as [SandboxLanguage, string][]) {
    const [repo, tag] = image.split(":");
    try {
      const res = await dockerRequest("GET", `/${API_VERSION}/images/json?filters=${encodeURIComponent(JSON.stringify({ reference: [`${repo}:${tag}`] }))}`);
      if (res.status === 200) {
        const images = JSON.parse(res.body.toString());
        if (Array.isArray(images) && images.length > 0) available.push(lang);
      }
    } catch {
      // skip
    }
  }
  return available;
}

export async function pullImage(language: SandboxLanguage): Promise<void> {
  const image = LANGUAGE_IMAGES[language];
  const [repo, tag] = image.split(":");
  const res = await dockerRequest("POST", `/${API_VERSION}/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`);
  if (res.status !== 200) {
    throw new Error(`Failed to pull ${image}: HTTP ${res.status}`);
  }
}

export async function executeInSandbox(opts: {
  language: SandboxLanguage;
  code: string;
  config: SandboxConfig;
  workspacePath?: string;
}): Promise<SandboxExecutionResult> {
  const { language, code, config, workspacePath } = opts;
  const image = LANGUAGE_IMAGES[language];
  const containerName = `chvor-sandbox-${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  // Build command based on language
  const cmd =
    language === "python" ? ["python3", "-c", code] :
    language === "node" ? ["node", "-e", code] :
    ["bash", "-c", code];

  // Create container
  const createBody = {
    Image: image,
    Cmd: cmd,
    Labels: { [CONTAINER_LABEL]: "true" },
    HostConfig: {
      Memory: config.memoryLimitMb * 1024 * 1024,
      CpuQuota: config.cpuQuota,
      NetworkMode: config.networkDisabled ? "none" : "bridge",
      Binds: workspacePath ? [`${workspacePath}:/workspace:rw`] : [],
    },
    WorkingDir: "/workspace",
    Tty: false,
  };

  const createRes = await dockerRequest(
    "POST",
    `/${API_VERSION}/containers/create?name=${containerName}`,
    createBody
  );
  if (createRes.status !== 201) {
    const errBody = createRes.body.toString();
    throw new Error(`Container create failed (${createRes.status}): ${errBody}`);
  }
  const { Id: containerId } = JSON.parse(createRes.body.toString());

  try {
    // Start container
    const startRes = await dockerRequest("POST", `/${API_VERSION}/containers/${containerId}/start`);
    if (startRes.status !== 204 && startRes.status !== 304) {
      throw new Error(`Container start failed: HTTP ${startRes.status}`);
    }

    // Wait for completion with timeout
    const timeoutMs = config.timeoutMs;
    let timedOut = false;

    const waitPromise = dockerRequest("POST", `/${API_VERSION}/containers/${containerId}/wait`);
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));

    const waitResult = await Promise.race([waitPromise, timeoutPromise]);

    if (waitResult === null) {
      timedOut = true;
      // Kill the container
      try {
        await dockerRequest("POST", `/${API_VERSION}/containers/${containerId}/kill`);
      } catch {
        // already dead
      }
    }

    // Read logs — Docker multiplexed stream format
    const logsRes = await dockerRequest(
      "GET",
      `/${API_VERSION}/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=0`
    );
    const { stdout, stderr } = demuxDockerLogs(logsRes.body);

    // Check OOM
    const inspectRes = await dockerRequest("GET", `/${API_VERSION}/containers/${containerId}/json`);
    let exitCode = -1;
    let oomKilled = false;
    if (inspectRes.status === 200) {
      const info = JSON.parse(inspectRes.body.toString());
      exitCode = info.State?.ExitCode ?? -1;
      oomKilled = info.State?.OOMKilled ?? false;
    }

    if (timedOut) exitCode = 124; // conventional timeout exit code

    return {
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
      exitCode,
      durationMs: Date.now() - startTime,
      timedOut,
      oomKilled,
    };
  } finally {
    // Always cleanup container
    try {
      await dockerRequest("DELETE", `/${API_VERSION}/containers/${containerId}?force=true`);
    } catch {
      // best effort
    }
  }
}

// ─── Internals ─────────────────────────────────────────────

async function cleanupOrphans(): Promise<void> {
  try {
    const res = await dockerRequest(
      "GET",
      `/${API_VERSION}/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [CONTAINER_LABEL] }))}`
    );
    if (res.status !== 200) return;
    const containers = JSON.parse(res.body.toString());
    for (const c of containers) {
      try {
        await dockerRequest("DELETE", `/${API_VERSION}/containers/${c.Id}?force=true`);
        console.log(`[sandbox] Cleaned up orphaned container ${c.Id.slice(0, 12)}`);
      } catch {
        // best effort
      }
    }
  } catch {
    // silent
  }
}

/** Demux Docker's multiplexed stdout/stderr stream format.
 *  Each frame: [streamType(1), 0, 0, 0, size(4 big-endian), payload(size)]
 *  streamType: 1=stdout, 2=stderr */
function demuxDockerLogs(raw: Buffer): { stdout: string; stderr: string } {
  const stdoutParts: Buffer[] = [];
  const stderrParts: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= raw.length) {
    const streamType = raw[offset];
    const size = raw.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > raw.length) break;

    const payload = raw.subarray(offset, offset + size);
    if (streamType === 1) stdoutParts.push(payload);
    else if (streamType === 2) stderrParts.push(payload);
    offset += size;
  }

  return {
    stdout: Buffer.concat(stdoutParts).toString("utf-8"),
    stderr: Buffer.concat(stderrParts).toString("utf-8"),
  };
}

/** Low-level Docker Engine API request via Unix socket or TCP */
function dockerRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const dockerHost = process.env.DOCKER_HOST;
    const bodyStr = body ? JSON.stringify(body) : undefined;

    // TCP transport (e.g., DOCKER_HOST=tcp://localhost:2375)
    if (dockerHost && dockerHost.startsWith("tcp://")) {
      const url = new URL(path, dockerHost.replace("tcp://", "http://"));
      const options: import("node:http").RequestOptions = {
        hostname: url.hostname,
        port: url.port || 2375,
        path: url.pathname + url.search,
        method,
        headers: bodyStr
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
          : {},
      };

      const req = httpRequest(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
      return;
    }

    // Unix socket transport (Linux/macOS) or named pipe (Windows)
    const socketPath = dockerHost?.startsWith("/") ? dockerHost : DOCKER_SOCKET;

    if (process.platform === "win32" && !dockerHost) {
      // Windows named pipe: use raw net.connect
      const socket = netConnect({ path: socketPath }, () => {
        const lines = [
          `${method} ${path} HTTP/1.1`,
          `Host: localhost`,
          ...(bodyStr
            ? [`Content-Type: application/json`, `Content-Length: ${Buffer.byteLength(bodyStr)}`]
            : []),
          `Connection: close`,
          ``,
          bodyStr ?? "",
        ];
        socket.write(lines.join("\r\n"));
      });

      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        const raw = Buffer.concat(chunks);
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          reject(new Error("Invalid HTTP response from Docker"));
          return;
        }
        const headerStr = raw.subarray(0, headerEnd).toString();
        const statusMatch = headerStr.match(/HTTP\/\d\.\d (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;
        const responseBody = raw.subarray(headerEnd + 4);
        resolve({ status, body: responseBody });
      });
      socket.on("error", reject);
      return;
    }

    // Unix socket transport
    const options: import("node:http").RequestOptions = {
      socketPath,
      path,
      method,
      headers: bodyStr
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
        : {},
    };

    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
