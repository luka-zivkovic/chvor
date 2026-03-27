import { execSync } from "node:child_process";
import { readConfig } from "../lib/config.js";

export async function open(): Promise<void> {
  const config = readConfig();
  const port = config.port ?? "3001";
  const url = `http://localhost:${port}`;

  switch (process.platform) {
    case "darwin":
      execSync(`open ${url}`);
      break;
    case "win32":
      execSync(`start ${url}`);
      break;
    default:
      execSync(`xdg-open ${url}`);
      break;
  }

  console.log(`Opened ${url}`);
}
