import type { tool } from "ai";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

import { webModule } from "./web.ts";
import { skillModule } from "./skill.ts";
import { scheduleModule } from "./schedule.ts";
import { webhookModule } from "./webhook.ts";
import { workflowModule } from "./workflow.ts";
import { integrationModule } from "./integration.ts";
import { credentialModule } from "./credential.ts";
import { modelModule } from "./model.ts";
import { browserModule } from "./browser.ts";
import { shellModule } from "./shell.ts";
import { claudeCodeModule } from "./claude-code.ts";
import { selfHealingModule } from "./self-healing.ts";
import { imageModule } from "./image.ts";
import { recallModule } from "./recall.ts";
import { knowledgeModule } from "./knowledge.ts";
import { registryModule } from "./registry.ts";
import { a2uiModule } from "./a2ui.ts";
import { pcControlModule } from "./pc-control.ts";
import { socialModule } from "./social.ts";
import { sandboxModule } from "./sandbox.ts";
import { synthesizedModule } from "./synthesized.ts";

// ---------------------------------------------------------------------------
// Re-exports of public API
// ---------------------------------------------------------------------------

export type { NativeToolContentItem, NativeToolResult, NativeToolContext } from "./types.ts";
export { validateFetchUrl } from "./security.ts";
export { resolveWorkflowParams } from "./workflow-params.ts";
export type { ResolvedWorkflowParams } from "./workflow-params.ts";
export { WORKFLOW_EXCLUDED_TOOLS } from "./workflow.ts";
export { resolveApproval } from "./shell.ts";
export { resolveCredentialRequest, resolveOAuthWizard } from "./credential.ts";

// ---------------------------------------------------------------------------
// Module aggregation
// ---------------------------------------------------------------------------

// Modules that are always registered (handlers + mappings always present).
// Conditionally-enabled modules may also live in this list — their `enabled`
// predicate gates only the public definition list, not the handler map (so a
// disabled tool that the AI still tries to call returns the handler's own
// disabled-message rather than a "no handler" error).
const ALL_MODULES: NativeToolModule[] = [
  webModule,
  skillModule,
  scheduleModule,
  webhookModule,
  workflowModule,
  integrationModule,
  credentialModule,
  modelModule,
  browserModule,
  shellModule,
  claudeCodeModule,
  selfHealingModule,
  imageModule,
  recallModule,
  knowledgeModule,
  registryModule,
  a2uiModule,
  pcControlModule,
  socialModule,
  sandboxModule,
  synthesizedModule,
];

// Build the unified handlers + mappings maps once at module load. These are
// always populated regardless of `enabled` so callNativeTool can dispatch
// every known native tool.
const handlers = new Map<string, NativeToolHandler>();
const nativeToolMapping = new Map<string, { kind: "skill" | "tool"; id: string }>();

for (const mod of ALL_MODULES) {
  for (const [name, handler] of Object.entries(mod.handlers)) {
    handlers.set(name, handler);
  }
  if (mod.mappings) {
    for (const [name, target] of Object.entries(mod.mappings)) {
      nativeToolMapping.set(name, target);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get the capability target a native tool maps to (for canvas node animation). */
export function getNativeToolTarget(qualifiedName: string): { kind: "skill" | "tool"; id: string } | null {
  return nativeToolMapping.get(qualifiedName) ?? null;
}

/** All native tool definitions (for merging into the tool map). */
export function getNativeToolDefinitions(): Record<string, ReturnType<typeof tool>> {
  const result: Record<string, ReturnType<typeof tool>> = {};
  for (const mod of ALL_MODULES) {
    if (mod.enabled && !mod.enabled()) continue;
    for (const [name, def] of Object.entries(mod.defs)) {
      result[name] = def;
    }
  }
  return result;
}

/** Check if a qualified tool name is a native tool. */
export function isNativeTool(qualifiedName: string): boolean {
  return handlers.has(qualifiedName);
}

/** Execute a native tool by its qualified name. */
export async function callNativeTool(
  qualifiedName: string,
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> {
  const handler = handlers.get(qualifiedName);
  if (!handler) throw new Error(`No native tool handler: ${qualifiedName}`);
  return handler(args, context);
}
