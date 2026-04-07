import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { input, select } from "@inquirer/prompts";
import { writeConfig } from "../lib/config.js";
import { validatePort } from "../lib/validate.js";
import { getDataDir, ensureDir } from "../lib/paths.js";
import { downloadRelease } from "../lib/download.js";
import { spawnServer, pollHealth } from "../lib/process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

export async function onboard(): Promise<void> {
  console.log(
    "\n  Welcome to chvor \u2014 your own AI.\n  Let's get you set up.\n"
  );

  const userName = await input({ message: "What's your name?" });

  const detectedTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = await input({
    message: "Your timezone?",
    default: detectedTimezone,
  });

  const provider = await select({
    message: "LLM provider?",
    choices: [
      { name: "Anthropic (Claude)", value: "anthropic" },
      { name: "OpenAI (GPT)", value: "openai" },
      { name: "Google (Gemini)", value: "google-ai" },
    ],
  });

  const port = validatePort(await input({ message: "Port?", default: "9147" }));

  const token = randomBytes(32).toString("hex");

  // Write config but do NOT mark as onboarded yet — that happens after
  // download + server start succeed, so a failed install doesn't leave
  // the user in a half-configured state.
  writeConfig({
    port,
    token,
    onboarded: false,
    llmProvider: provider,
  });

  ensureDir(getDataDir());

  const version = pkg.version;
  await downloadRelease(version);

  await spawnServer({ port });

  const serverReady = await pollHealth(port, token, 30000);

  if (serverReady) {
    try {
      const personaRes = await fetch(`http://localhost:${port}/api/persona`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: userName,
          timezone,
          onboarded: true,
        }),
      });
      if (!personaRes.ok) {
        console.warn(`Warning: failed to save persona (${personaRes.status}). You can update it later in the UI.`);
      }
    } catch {
      console.warn("Warning: could not reach server to save persona. You can update it later in the UI.");
    }
  } else {
    console.warn(
      "\n  Server is still starting up. Your config has been saved." +
      "\n  Persona will be configured when you open the UI."
    );
  }

  // Mark as onboarded only after download + server start succeeded
  writeConfig({
    port,
    token,
    onboarded: true,
    llmProvider: provider,
    installedVersion: version,
  });

  console.log(`\n  chvor is running at http://localhost:${port}`);
  console.log("  Open this URL in your browser to get started.");
  console.log("  You can add your API key in Settings once you're in.\n");
  console.log("  Useful commands:");
  console.log("    chvor stop            Stop the server");
  console.log("    chvor start           Start the server");
  console.log("    chvor open            Open chvor in your browser");
  console.log("    chvor service install  Start automatically on login");
  console.log("    chvor update          Update to latest version\n");
  console.log("  Tip: For system tray, auto-updates, and no terminal needed,");
  console.log("  try the desktop app: https://github.com/luka-zivkovic/chvor/releases/latest\n");
}
