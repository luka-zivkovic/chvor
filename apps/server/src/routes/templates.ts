import { Hono } from "hono";
import { stringify as yamlStringify } from "yaml";
import { getPersona, getAllInstructionOverrides } from "../db/config-store.ts";
import { loadSkills, loadTools } from "../lib/capability-loader.ts";
import { isCapabilityEnabled } from "../db/config-store.ts";
import { listCredentials } from "../db/credential-store.ts";
import { listSchedules } from "../db/schedule-store.ts";
import { getOrCreateDefault } from "../db/workspace-store.ts";
import type { TemplateManifest, TemplateSkillOverride, TemplateCredentialDef, TemplateScheduleDef } from "@chvor/shared";

const templates = new Hono();

/**
 * GET /api/templates/export — export current assistant configuration as a template YAML.
 * Includes: persona, enabled skills/tools, instruction overrides, credential types (no secrets),
 * schedules, and pipeline.
 */
templates.get("/export", (c) => {
  try {
    const persona = getPersona();

    // Enabled skills/tools (non-bundled only — bundled are always available)
    const enabledSkills = loadSkills()
      .filter((s) => s.source !== "bundled" && isCapabilityEnabled("skill", s.id))
      .map((s) => s.id);
    const enabledTools = loadTools()
      .filter((t) => !t.builtIn && isCapabilityEnabled("tool", t.id))
      .map((t) => t.id);

    // Instruction overrides
    const overrides = getAllInstructionOverrides();
    const skillOverrides: TemplateSkillOverride[] = overrides
      .filter((o) => o.kind === "skill")
      .map((o) => ({ skillId: o.id, instructions: o.instructions }));

    // Credential types (no secrets — only type and field schema)
    const credentials: TemplateCredentialDef[] = listCredentials().map((cred) => ({
      type: cred.type,
      name: cred.name,
      description: `${cred.type} integration`,
      fields: Object.keys(cred.redactedFields).map((fieldName) => ({
        name: fieldName,
        label: fieldName.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()),
        secret: true,
      })),
    }));

    // Schedules
    const allSchedules = listSchedules();
    const schedules: TemplateScheduleDef[] = allSchedules.map((s) => ({
      name: s.name,
      cronExpression: s.cronExpression,
      prompt: s.prompt,
      ...(s.oneShot ? { oneShot: true } : {}),
    }));

    // Pipeline
    const workspace = getOrCreateDefault("constellation");
    const hasPipeline = workspace.nodes.length > 0;

    const manifest: TemplateManifest & { includes?: string[] } = {
      name: persona.aiName || "My Assistant",
      description: `Exported assistant template`,
      version: "1.0.0",
      ...(persona.aiName ? { author: persona.name || undefined } : {}),

      persona: {
        ...(persona.profile ? { profile: persona.profile } : {}),
        ...(persona.directives ? { directives: persona.directives } : {}),
        ...(persona.aiName ? { aiName: persona.aiName } : {}),
        ...(persona.tone ? { tone: persona.tone } : {}),
        ...(persona.boundaries ? { boundaries: persona.boundaries } : {}),
        ...(persona.communicationStyle ? { communicationStyle: persona.communicationStyle } : {}),
        ...(persona.exampleResponses?.length ? { exampleResponses: persona.exampleResponses } : {}),
      },

      ...(enabledSkills.length > 0 || enabledTools.length > 0
        ? { includes: [...enabledSkills, ...enabledTools] }
        : {}),

      ...(skillOverrides.length > 0 ? { skillOverrides } : {}),
      ...(credentials.length > 0 ? { credentials } : {}),
      ...(schedules.length > 0 ? { schedules } : {}),
      ...(hasPipeline
        ? { pipeline: { nodes: workspace.nodes, edges: workspace.edges } }
        : {}),
    };

    const yaml = yamlStringify(manifest, { lineWidth: 120 });

    c.header("Content-Type", "text/yaml");
    c.header("Content-Disposition", `attachment; filename="template.yaml"`);
    return c.body(yaml);
  } catch (err) {
    console.error("[api] GET /templates/export error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

export default templates;
