import { readdirSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TemplateManifest } from "../types/template.js";
import { getSkillsDir, getToolsDir, ensureDir } from "./paths.js";
import { getTemplateSkillsDir, getTemplateToolsDir } from "./template-loader.js";

interface ProvisionContext {
  port: string;
  token: string;
  templatePath: string;
  manifest: TemplateManifest;
}

function apiUrl(port: string, path: string): string {
  return `http://localhost:${port}${path}`;
}

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function applyPersona(ctx: ProvisionContext): Promise<void> {
  if (!ctx.manifest.persona) return;

  const res = await fetch(apiUrl(ctx.port, "/api/persona"), {
    method: "PATCH",
    headers: authHeaders(ctx.token),
    body: JSON.stringify(ctx.manifest.persona),
  });

  if (!res.ok) {
    console.warn(`Warning: failed to apply persona (${res.status}).`);
  }
}

async function createSchedules(ctx: ProvisionContext): Promise<void> {
  if (!ctx.manifest.schedules?.length) return;

  // Get default workspace ID for schedule association
  const wsRes = await fetch(apiUrl(ctx.port, "/api/workspaces"), {
    headers: authHeaders(ctx.token),
  });

  let workspaceId = "default";
  if (wsRes.ok) {
    const workspaces = (await wsRes.json()) as { id: string }[];
    if (workspaces.length > 0) {
      workspaceId = workspaces[0].id;
    }
  }

  for (const schedule of ctx.manifest.schedules) {
    const res = await fetch(apiUrl(ctx.port, "/api/schedules"), {
      method: "POST",
      headers: authHeaders(ctx.token),
      body: JSON.stringify({
        ...schedule,
        workspaceId,
      }),
    });
    if (!res.ok) {
      console.warn(`Warning: failed to create schedule "${schedule.name}" (${res.status}).`);
    }
  }
}

async function createPipeline(ctx: ProvisionContext): Promise<void> {
  if (!ctx.manifest.pipeline) return;

  const res = await fetch(apiUrl(ctx.port, "/api/workspaces"), {
    method: "POST",
    headers: authHeaders(ctx.token),
    body: JSON.stringify({
      name: `${ctx.manifest.name} Pipeline`,
      mode: "pipeline",
      nodes: ctx.manifest.pipeline.nodes,
      edges: ctx.manifest.pipeline.edges,
    }),
  });

  if (!res.ok) {
    console.warn(`Warning: failed to create pipeline (${res.status}).`);
  }
}

function copyTemplateFiles(ctx: ProvisionContext): void {
  const skillsSrc = getTemplateSkillsDir(ctx.templatePath);
  if (skillsSrc) {
    const destDir = getSkillsDir();
    ensureDir(destDir);
    const files = readdirSync(skillsSrc).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      copyFileSync(join(skillsSrc, file), join(destDir, file));
    }
    if (files.length > 0) {
      console.log(`  Copied ${files.length} custom skill(s).`);
    }
  }

  const toolsSrc = getTemplateToolsDir(ctx.templatePath);
  if (toolsSrc) {
    const destDir = getToolsDir();
    ensureDir(destDir);
    const files = readdirSync(toolsSrc).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      copyFileSync(join(toolsSrc, file), join(destDir, file));
    }
    if (files.length > 0) {
      console.log(`  Copied ${files.length} custom tool(s).`);
    }
  }
}

export async function provision(ctx: ProvisionContext): Promise<void> {
  console.log(`\n  Provisioning "${ctx.manifest.name}" template...`);

  // Copy template skill/tool files first (before server loads them)
  copyTemplateFiles(ctx);

  // Reload capabilities so server picks up new files
  const skillsRes = await fetch(apiUrl(ctx.port, "/api/skills/reload"), {
    method: "POST",
    headers: authHeaders(ctx.token),
  });
  if (!skillsRes.ok) {
    console.warn(`  Warning: failed to reload skills (${skillsRes.status}).`);
  }
  const toolsRes = await fetch(apiUrl(ctx.port, "/api/tools/reload"), {
    method: "POST",
    headers: authHeaders(ctx.token),
  });
  if (!toolsRes.ok) {
    console.warn(`  Warning: failed to reload tools (${toolsRes.status}).`);
  }

  await applyPersona(ctx);
  await createSchedules(ctx);
  await createPipeline(ctx);

  console.log("  Template provisioned successfully.");
}
