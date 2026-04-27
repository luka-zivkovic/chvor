import { tool } from "ai";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LLM_CRED_TYPES } from "../provider-registry.ts";
import { sanitizeYamlValue } from "./security.ts";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Create Skill tool
// ---------------------------------------------------------------------------
const CREATE_SKILL_TOOL_NAME = "native__create_skill";
export const USER_SKILLS_DIR = join(homedir(), ".chvor", "skills");

const createSkillToolDef = tool({
  description:
    "[Create Skill] Register a new integration/skill that appears on the Brain Canvas. Use this when you successfully connect to a new service or API and want it visible as a skill node. Do NOT use this for services that already have a saved credential — those already appear as integration nodes on the canvas automatically.",
  parameters: z.object({
    id: z
      .string()
      .describe("Unique slug (lowercase, hyphens ok). Used as filename."),
    name: z.string().describe("Display name (e.g. 'Coolify', 'Notion')"),
    description: z
      .string()
      .describe("Short description of what this skill does"),
    category: z
      .enum([
        "ai",
        "communication",
        "data",
        "developer",
        "file",
        "productivity",
        "web",
      ])
      .optional()
      .describe("Skill category"),
    icon: z
      .string()
      .optional()
      .describe("Icon name (e.g. 'server', 'cloud', 'database')"),
    instructions: z
      .string()
      .describe(
        "Instructions for the LLM on how to use this integration in future conversations"
      ),
    skillType: z
      .enum(["prompt", "workflow"])
      .optional()
      .describe("Skill type: 'prompt' for behavioral instructions, 'workflow' for multi-step procedures. Defaults to 'prompt'."),
  }),
});

/** Skill IDs managed by bundled skills — cannot be created by the AI. */
const RESERVED_SKILL_IDS = new Set(["getting-started", "get-started", "chvor-guide"]);

const handleCreateSkill: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const id = String(args.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const name = String(args.name);

  // Guard: reserved skill IDs handled by bundled skills
  if (RESERVED_SKILL_IDS.has(id)) {
    return {
      content: [{ type: "text", text: `Skipped: "${id}" is reserved. First-run guidance is handled by the built-in Chvor Guide skill.` }],
    };
  }

  // Guard: prevent overwriting bundled skills
  const { getSkill: lookupSkill } = await import("../capability-loader.ts");
  const existingSkill = lookupSkill(id);
  if (existingSkill?.source === "bundled") {
    return {
      content: [{ type: "text", text: `Cannot create skill "${id}" — a bundled skill with this ID exists. Choose a different ID.` }],
    };
  }

  // Guard: skip if a non-LLM credential already covers this service
  const { listCredentials } = await import("../../db/credential-store.ts");
  const integrationCreds = listCredentials().filter((c) => !LLM_CRED_TYPES.has(c.type));
  const idLower = id.toLowerCase();
  const nameLower = name.toLowerCase();
  const matchedCred = integrationCreds.find((c) => {
    const credSlug = c.name.toLowerCase().replace(/\s+/g, "-");
    return credSlug === idLower || credSlug === nameLower || c.name.toLowerCase() === nameLower;
  });
  if (matchedCred) {
    return {
      content: [
        {
          type: "text",
          text: `Skipped: a credential for '${matchedCred.name}' already exists and appears on the canvas as an integration node. No skill creation needed.`,
        },
      ],
    };
  }

  const description = String(args.description);
  const category = args.category ? String(args.category) : undefined;
  const icon = args.icon ? String(args.icon) : undefined;
  const instructions = String(args.instructions);

  const skillType = args.skillType ? String(args.skillType) : undefined;

  // Guard: redirect workflow creation to dedicated native__create_workflow tool
  if (skillType === "workflow") {
    return {
      content: [
        {
          type: "text",
          text: `Use native__create_workflow instead of native__create_skill for workflow-type skills. It supports structured steps and parameters.`,
        },
      ],
    };
  }

  const frontmatter: string[] = [
    `name: ${sanitizeYamlValue(name)}`,
    `description: ${sanitizeYamlValue(description)}`,
    `version: 1.0.0`,
  ];
  if (skillType) frontmatter.push(`type: ${sanitizeYamlValue(skillType)}`);
  if (category) frontmatter.push(`category: ${sanitizeYamlValue(category)}`);
  if (icon) frontmatter.push(`icon: ${sanitizeYamlValue(icon)}`);

  const content = `---\n${frontmatter.join("\n")}\n---\n${instructions}\n`;

  mkdirSync(USER_SKILLS_DIR, { recursive: true });
  const filePath = join(USER_SKILLS_DIR, `${id}.md`);
  writeFileSync(filePath, content, "utf8");

  return {
    content: [
      {
        type: "text",
        text: `Skill "${name}" (id: ${id}) created at ${filePath}. It will appear on the Brain Canvas.`,
      },
    ],
  };
};

export const skillModule: NativeToolModule = {
  defs: { [CREATE_SKILL_TOOL_NAME]: createSkillToolDef },
  handlers: { [CREATE_SKILL_TOOL_NAME]: handleCreateSkill },
};
