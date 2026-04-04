import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { input, select, password, confirm } from "@inquirer/prompts";
import { writeConfig, readConfig } from "../lib/config.js";
import { validatePort } from "../lib/validate.js";
import {
  getChvorHome,
  getDataDir,
  setInstance,
  ensureDir,
} from "../lib/paths.js";
import { downloadRelease, isInstalled } from "../lib/download.js";
import { spawnServer, pollHealth } from "../lib/process.js";
import {
  resolveTemplate,
  resolveRegistryTemplate,
  listBundledTemplates,
  fetchRegistryIndex,
} from "../lib/template-loader.js";
import { provision } from "../lib/template-provisioner.js";
import type { TemplateManifest, TemplateCredentialDef } from "../types/template.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8")
) as { version: string };

interface InitOptions {
  template?: string;
  name?: string;
  from?: string;
}

async function pickRegistryTemplate(): Promise<{ path: string; manifest: TemplateManifest }> {
  console.log("\n  Fetching templates from registry...");
  const index = await fetchRegistryIndex();
  const templates = index.entries.filter((e) => e.kind === "template");

  if (templates.length === 0) {
    console.log("  No templates found in registry.");
    return pickTemplate();
  }

  const choice = await select({
    message: "Choose a registry template:",
    choices: [
      ...templates.map((t) => ({
        name: `${t.name ?? t.id} — ${t.description ?? ""}`,
        value: t.id,
      })),
      { name: "← Back to bundled templates", value: "__back__" },
    ],
  });

  if (choice === "__back__") return pickTemplate();

  console.log(`  Downloading template "${choice}"...`);
  return resolveRegistryTemplate(choice, index);
}

async function pickTemplate(): Promise<{ path: string; manifest: TemplateManifest }> {
  const bundled = listBundledTemplates();

  const choices: Array<{ name: string; value: string }> = bundled.map((t) => ({
    name: `${t.name} — ${t.description}`,
    value: t.id,
  }));

  choices.push({ name: "── Browse community registry ──", value: "__registry__" });

  if (choices.length === 1) {
    // Only the registry option — no bundled templates
    console.log("  No bundled templates found. Checking registry...");
    return pickRegistryTemplate();
  }

  const choice = await select({
    message: "Choose a template:",
    choices,
  });

  if (choice === "__registry__") return pickRegistryTemplate();

  return resolveTemplate(choice);
}

async function collectCredentials(
  credentialDefs: TemplateCredentialDef[],
  port: string,
  token: string
): Promise<void> {
  if (!credentialDefs.length) return;

  console.log("\n  This template requires the following credentials:\n");

  for (const cred of credentialDefs) {
    console.log(`  ${cred.name}: ${cred.description}`);

    const data: Record<string, string> = {};
    for (const field of cred.fields) {
      if (field.secret) {
        data[field.name] = await password({ message: `  ${field.label}:` });
      } else {
        data[field.name] = await input({ message: `  ${field.label}:` });
      }
    }

    const res = await fetch(`http://localhost:${port}/api/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: cred.name,
        type: cred.type,
        data,
      }),
    });

    if (!res.ok) {
      console.warn(`  Warning: failed to save ${cred.name} credential (${res.status}).`);
    } else {
      console.log(`  ${cred.name} credential saved.`);
    }
  }
}

export async function init(opts: InitOptions): Promise<void> {
  console.log("\n  chvor init — set up a new agent from a template.\n");

  // 1. Resolve template
  let templatePath: string;
  let manifest: TemplateManifest;
  let isRegistryTemplate = false;

  const source = opts.from || opts.template;
  if (source?.startsWith("registry:")) {
    const id = source.slice("registry:".length);
    console.log(`  Fetching template "${id}" from registry...`);
    const result = await resolveRegistryTemplate(id);
    templatePath = result.path;
    manifest = result.manifest;
    isRegistryTemplate = true;
  } else if (source) {
    const result = resolveTemplate(source);
    templatePath = result.path;
    manifest = result.manifest;
  } else {
    const result = await pickTemplate();
    templatePath = result.path;
    manifest = result.manifest;
  }

  console.log(`  Template: ${manifest.name} (v${manifest.version})`);
  if (manifest.description) {
    console.log(`  ${manifest.description}\n`);
  }

  // 2. Instance name
  const instanceName = opts.name ?? await input({
    message: "Instance name (leave blank for default):",
    default: "",
  });

  if (instanceName) {
    // Validate instance name: alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(instanceName)) {
      throw new Error(
        "Instance name must contain only letters, numbers, hyphens, and underscores."
      );
    }
    setInstance(instanceName);
  }

  const home = getChvorHome();
  if (existsSync(join(home, "config.json"))) {
    const overwrite = await confirm({
      message: `Instance directory ${home} already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("  Aborted.");
      return;
    }
  }

  // 3. Basic onboarding prompts
  const userName = await input({ message: "What's your name?" });

  const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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

  const defaultPort = instanceName ? "9148" : "9147";
  const port = validatePort(
    await input({ message: "Port?", default: defaultPort })
  );

  const token = randomBytes(32).toString("hex");

  // 4. Write config (not yet onboarded — set after download + server start)
  writeConfig({
    port,
    token,
    onboarded: false,
    llmProvider: provider,
    instanceName: instanceName || undefined,
    templateName: manifest.name,
  });

  ensureDir(getDataDir());

  // 5. Download release if needed
  const version = pkg.version;
  if (!isInstalled(version)) {
    await downloadRelease(version);
  }

  // 6. Start server
  await spawnServer({ port });
  const healthy = await pollHealth(port, token);
  if (!healthy) {
    console.warn(
      "  Server started but health check did not pass within timeout."
    );
    return;
  }

  // 7. Save persona (user name + timezone + template persona)
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
      }),
    });
    if (!personaRes.ok) {
      console.warn(`  Warning: failed to save persona (${personaRes.status}). You can update it later in Settings.`);
    }
  } catch {
    console.warn("  Warning: could not reach server to save persona. You can update it later in Settings.");
  }

  // 8. Collect template-specific credentials
  await collectCredentials(manifest.credentials ?? [], port, token);

  // 9. Provision template
  await provision({
    port,
    token,
    templatePath,
    manifest,
  });

  // Clean up temp directory from registry template
  if (isRegistryTemplate) {
    try { rmSync(templatePath, { recursive: true, force: true }); } catch { /* non-critical */ }
  }

  // 10. Mark as onboarded now that everything succeeded
  writeConfig({
    port,
    token,
    onboarded: true,
    llmProvider: provider,
    instanceName: instanceName || undefined,
    templateName: manifest.name,
    installedVersion: version,
  });

  // 11. Done
  const label = instanceName ? ` (instance: ${instanceName})` : "";
  console.log(`\n  chvor is running at http://localhost:${port}${label}`);
  console.log("  Open this URL in your browser to get started.\n");
  console.log("  Useful commands:");
  if (instanceName) {
    console.log(`    chvor stop --instance ${instanceName}     Stop this instance`);
    console.log(`    chvor start --instance ${instanceName}    Start this instance`);
    console.log("    chvor instances                          List all instances");
  } else {
    console.log("    chvor stop     Stop the server");
    console.log("    chvor start    Start the server");
  }
  console.log("    chvor update   Update to latest version\n");
}
