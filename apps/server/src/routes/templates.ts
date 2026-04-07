import { Hono } from "hono";
import { stringify as yamlStringify } from "yaml";
import { getPersona, getAllInstructionOverrides } from "../db/config-store.ts";
import { loadSkills, loadTools } from "../lib/capability-loader.ts";
import { isCapabilityEnabled } from "../db/config-store.ts";
import { listCredentials } from "../db/credential-store.ts";
import { listSchedules } from "../db/schedule-store.ts";
import { listWorkspaces } from "../db/workspace-store.ts";
import type { TemplateManifest, TemplateSkillOverride, TemplateCredentialDef, TemplateScheduleDef } from "@chvor/shared";

const templates = new Hono();

/**
 * GET /api/templates/export — export current assistant configuration as a template YAML.
 * Includes: persona, enabled skills/tools, instruction overrides, credential types (no secrets),
 * schedules, and pipeline.
 */
templates.get("/export", async (c) => {
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

    // Credential types — only include types required by enabled skills/tools (no secrets)
    const requiredCredTypes = new Set<string>();
    for (const s of loadSkills().filter((s) => isCapabilityEnabled("skill", s.id))) {
      for (const c of s.metadata.requires?.credentials ?? []) requiredCredTypes.add(c);
    }
    for (const t of loadTools().filter((t) => isCapabilityEnabled("tool", t.id))) {
      for (const c of t.metadata.requires?.credentials ?? []) requiredCredTypes.add(c);
    }
    const credentials: TemplateCredentialDef[] = listCredentials()
      .filter((cred) => requiredCredTypes.has(cred.type))
      .map((cred) => ({
        type: cred.type,
        name: cred.name,
        description: `${cred.type} integration`,
        fields: Object.keys(cred.redactedFields).map((fieldName) => ({
          name: fieldName,
          label: fieldName.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()),
          secret: true,
        })),
      }));

    // Schedules — only include user-created schedules, not template-provisioned ones
    const allSchedules = listSchedules();
    const templateScheduleIds = new Set<string>();
    try {
      const { readLock } = await import("../lib/registry-manager.ts");
      const lock = readLock();
      for (const info of Object.values(lock.installed)) {
        if (info.provisionedScheduleIds) {
          for (const sid of info.provisionedScheduleIds) templateScheduleIds.add(sid);
        }
      }
    } catch { /* lock may not exist */ }
    const schedules: TemplateScheduleDef[] = allSchedules
      .filter((s) => !templateScheduleIds.has(s.id))
      .map((s) => ({
        name: s.name,
        cronExpression: s.cronExpression,
        prompt: s.prompt,
        ...(s.oneShot ? { oneShot: true } : {}),
      }));

    // Pipeline — only export template-provisioned pipeline workspaces, not the default constellation
    // Template pipelines use IDs like "template-{id}-pipeline"
    const pipelineWorkspaces = listWorkspaces().filter(
      (ws) => ws.id.startsWith("template-") && ws.nodes.length > 0,
    );
    const hasPipeline = pipelineWorkspaces.length > 0;
    const pipelineWorkspace = pipelineWorkspaces[0];

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
      ...(hasPipeline && pipelineWorkspace
        ? { pipeline: { nodes: pipelineWorkspace.nodes, edges: pipelineWorkspace.edges } }
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
