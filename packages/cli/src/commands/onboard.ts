import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { input, select, password } from "@inquirer/prompts";
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

  const apiKey = await password({ message: "API key:" });

  const port = validatePort(await input({ message: "Port?", default: "3001" }));

  const token = randomBytes(32).toString("hex");

  writeConfig({
    port,
    token,
    onboarded: true,
    llmProvider: provider,
  });

  ensureDir(getDataDir());

  const version = pkg.version;
  await downloadRelease(version);

  await spawnServer({ port });

  await pollHealth(port, token);

  const providerNames: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    "google-ai": "Google AI",
  };

  const credRes = await fetch(`http://localhost:${port}/api/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: providerNames[provider],
      type: provider,
      data: { apiKey },
    }),
  });
  if (!credRes.ok) {
    console.warn(`Warning: failed to save credentials (${credRes.status}). You can add them later in the UI.`);
  }

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

  console.log(`\n  chvor is running at http://localhost:${port}`);
  console.log("  Open this URL in your browser to get started.\n");
  console.log("  Useful commands:");
  console.log("    chvor stop     Stop the server");
  console.log("    chvor start    Start the server");
  console.log("    chvor update   Update to latest version\n");
}
