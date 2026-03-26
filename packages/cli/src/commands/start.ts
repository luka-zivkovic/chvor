import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../lib/config.js";
import { downloadRelease, isInstalled } from "../lib/download.js";
import { spawnServer } from "../lib/process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

export async function start(opts: {
  port?: string;
  foreground?: boolean;
}): Promise<void> {
  const config = readConfig();
  const version = pkg.version;

  if (!isInstalled(version)) {
    await downloadRelease(version);
  }

  await spawnServer({
    port: opts.port ?? config.port,
    foreground: opts.foreground,
  });
}
