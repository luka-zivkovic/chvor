import { EVALUATION_RUN_MAX_BYTES } from "@chvor/shared";
import { runEvaluationSidecar } from "./sidecar-engine.ts";
import type { EvaluationSidecarRequest } from "./sidecar-protocol.ts";

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > EVALUATION_RUN_MAX_BYTES + 64 * 1024) throw new Error("sidecar request too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const request = JSON.parse(await readInput()) as EvaluationSidecarRequest;
  const response = await runEvaluationSidecar(request);
  process.stdout.write(JSON.stringify(response));
} catch {
  process.stderr.write("evaluation sidecar failed\n");
  process.exitCode = 2;
}
