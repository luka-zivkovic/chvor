import { execFileSync } from "node:child_process";
import { validatePort } from "../lib/validate.js";

export async function docker(opts: { port?: string }): Promise<void> {
  const port = validatePort(opts.port ?? "9147");
  const image = "ghcr.io/luka-zivkovic/chvor:latest";

  console.log("Pulling latest chvor Docker image...");
  execFileSync("docker", ["pull", image], { stdio: "inherit" });

  console.log("Starting chvor container...");
  execFileSync("docker", [
    "run", "-d", "--name", "chvor",
    "-p", `${port}:9147`,
    "-v", "chvor-data:/data",
    image,
  ], { stdio: "inherit" });

  console.log(`chvor is running at http://localhost:${port}`);
}
