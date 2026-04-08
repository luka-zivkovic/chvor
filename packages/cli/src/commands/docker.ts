import { execFileSync } from "node:child_process";
import { validatePort } from "../lib/validate.js";

export async function docker(opts: { port?: string }): Promise<void> {
  const port = validatePort(opts.port ?? "9147");
  const image = "ghcr.io/luka-zivkovic/chvor:latest";

  console.log("Pulling latest chvor Docker image...");
  execFileSync("docker", ["pull", image], { stdio: "inherit" });

  // Remove existing container if present (from a previous run)
  try {
    execFileSync("docker", ["rm", "-f", "chvor"], { stdio: "ignore" });
  } catch {
    // no existing container — fine
  }

  console.log("Starting chvor container...");
  execFileSync("docker", [
    "run", "-d", "--name", "chvor",
    "-p", `${port}:9147`,
    "-v", "chvor-data:/data",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    image,
  ], { stdio: "inherit" });

  console.log(`chvor is running at http://localhost:${port}`);
}
