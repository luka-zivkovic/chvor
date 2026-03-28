import { execFileSync } from "node:child_process";
import { readConfig } from "../lib/config.js";

export async function open(): Promise<void> {
  const config = readConfig();
  const port = config.port ?? "9147";
  const url = `http://localhost:${port}`;

  switch (process.platform) {
    case "darwin":
      execFileSync("open", [url]);
      break;
    case "win32":
      execFileSync("cmd", ["/c", "start", "", url]);
      break;
    default:
      execFileSync("xdg-open", [url]);
      break;
  }

  console.log(`Opened ${url}`);
}
