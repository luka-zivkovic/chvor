import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVALUATION_RUN_MAX_BYTES } from "@chvor/shared";
import type { EvaluationSidecarRequest, EvaluationSidecarResponse } from "./sidecar-protocol.ts";

export async function invokeEvaluationSidecar(
  request: EvaluationSidecarRequest,
  signal?: AbortSignal
): Promise<EvaluationSidecarResponse> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload, "utf8") > EVALUATION_RUN_MAX_BYTES + 64 * 1024) {
    throw new Error("evaluation sidecar request too large");
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const extension = extname(fileURLToPath(import.meta.url));
  const sidecarPath = join(here, `sidecar${extension}`);
  const args = extension === ".ts" ? ["--import", "tsx", sidecarPath] : [sidecarPath];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        TZ: "UTC",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, response?: EvaluationSidecarResponse) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(response as EvaluationSidecarResponse);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("evaluation run aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > EVALUATION_RUN_MAX_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("evaluation sidecar response too large"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.on("error", () => finish(new Error("could not start evaluation sidecar")));
    child.on("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || "evaluation sidecar failed"));
        return;
      }
      try {
        finish(
          undefined,
          JSON.parse(Buffer.concat(stdout).toString("utf8")) as EvaluationSidecarResponse
        );
      } catch {
        finish(new Error("evaluation sidecar returned invalid JSON"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(payload);
    if (signal?.aborted) abort();
  });
}
