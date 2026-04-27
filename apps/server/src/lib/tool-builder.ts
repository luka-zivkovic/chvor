import { tool } from "ai";
import { z } from "zod";
import type { Tool, SynthesizedEndpoint, SynthesizedEndpointParam, ToolBagScope } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { mcpManager } from "./mcp-manager.ts";
import { hasRequiredCredentials } from "./credential-resolver.ts";
import { getNativeToolDefinitions } from "./native-tools.ts";
import { buildCapabilityRegistry, invalidateCapabilityRegistry } from "./capability-resolver.ts";
import { filterTools, applyScopeToDefs } from "./tool-groups.ts";

const MAX_SCHEMA_DEPTH = 5;

/**
 * Convert a JSON Schema property to a Zod type.
 * Recurses into nested objects and typed arrays up to MAX_SCHEMA_DEPTH.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>, depth: number): z.ZodType {
  if (depth > MAX_SCHEMA_DEPTH) return z.unknown();

  // Handle union types: {"type": ["string", "null"]} → z.union([z.string(), z.null()])
  if (Array.isArray(prop.type)) {
    const members = (prop.type as string[]).map((t) =>
      jsonSchemaPropertyToZod({ ...prop, type: t }, depth)
    );
    if (members.length === 1) return members[0];
    if (members.length >= 2) return z.union(members as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    return z.unknown();
  }

  switch (prop.type) {
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items && typeof items === "object") {
        return z.array(jsonSchemaPropertyToZod(items, depth + 1));
      }
      return z.array(z.unknown());
    }
    case "object": {
      const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
        return jsonSchemaObjectToZod(prop, depth + 1);
      }
      // No inner properties — use record
      const additionalProps = prop.additionalProperties as Record<string, unknown> | undefined;
      if (additionalProps && typeof additionalProps === "object" && additionalProps.type) {
        return z.record(jsonSchemaPropertyToZod(additionalProps, depth + 1));
      }
      return z.record(z.unknown());
    }
    default:
      // Enums
      if (Array.isArray(prop.enum) && prop.enum.length > 0) {
        const values = prop.enum.map(String) as [string, ...string[]];
        return z.enum(values);
      }
      return z.string();
  }
}

/**
 * Convert a JSON Schema object (with properties) to a Zod object schema.
 */
function jsonSchemaObjectToZod(schema: Record<string, unknown>, depth = 0): z.ZodType {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  if (Object.keys(properties).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema = jsonSchemaPropertyToZod(prop, depth);

    if (prop.description) {
      fieldSchema = fieldSchema.describe(String(prop.description));
    }

    if (!required.includes(key)) {
      fieldSchema = fieldSchema.optional();
    }

    shape[key] = fieldSchema;
  }

  return z.object(shape);
}

// Memoization: return the same tool definitions when tools haven't changed.
// This helps prompt caching by keeping tool JSON stable across turns.
// Hash combines tool IDs + scope signature so cache invalidates on scope change.
let cachedToolHash: string | null = null;
let cachedToolDefs: Record<string, ReturnType<typeof tool>> | null = null;
// Dedup: return in-flight build promise to concurrent callers (only when hash matches)
let inflightBuild: { hash: string; promise: Promise<Record<string, ReturnType<typeof tool>>> } | null = null;

function scopeSignature(scope?: ToolBagScope): string {
  if (!scope || scope.isPermissive) return "permissive";
  const groups = Array.from(scope.groups).sort().join(",");
  const required = Array.from(scope.requiredTools).sort().join(",");
  const denied = Array.from(scope.deniedTools).sort().join(",");
  return `g:${groups}|r:${required}|d:${denied}`;
}

/** Tools that failed MCP discovery on last build — surfaced to LLM via system prompt. */
export interface FailedTool {
  id: string;
  name: string;
  reason: string;
}
let lastFailedTools: FailedTool[] = [];

/** Get the list of tools that failed to discover on the last build. */
export function getFailedTools(): FailedTool[] {
  return lastFailedTools;
}

/**
 * Build Vercel AI SDK tool definitions from loaded tools.
 * Tool names are prefixed: "toolId__mcpToolName" to avoid collisions.
 * No execute callback — orchestrator handles the loop manually.
 * Results are memoized by tool IDs to improve prompt cache hit rates.
 * Concurrent calls are deduplicated.
 */
function zodForEndpointParam(p: SynthesizedEndpointParam): z.ZodType {
  switch (p.type) {
    case "integer":
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    default:
      return z.string();
  }
}

function buildSynthesizedToolDefs(t: Tool): Record<string, ReturnType<typeof tool>> {
  const defs: Record<string, ReturnType<typeof tool>> = {};
  if (!t.endpoints || !t.synthesized) return defs;

  const verifiedTag = t.synthesized.verified ? "" : " [unverified]";

  for (const ep of t.endpoints) {
    const shape: Record<string, z.ZodType> = {};
    const pathNames = new Set<string>();

    for (const p of ep.pathParams ?? []) {
      let s: z.ZodType = zodForEndpointParam(p);
      if (p.description) s = s.describe(p.description);
      shape[p.name] = p.required ? s : s.optional();
      pathNames.add(p.name);
    }
    for (const p of ep.queryParams ?? []) {
      if (pathNames.has(p.name)) {
        console.warn(
          `[tool-builder] ${t.id}__${ep.name}: query param "${p.name}" collides with path param; query value will be ignored. Rename the query param in the tool file.`,
        );
        continue;
      }
      let s: z.ZodType = zodForEndpointParam(p);
      if (p.description) s = s.describe(p.description);
      shape[p.name] = p.required ? s : s.optional();
    }
    if (ep.bodySchema && ep.method !== "GET") {
      shape.body = z.record(z.unknown()).optional().describe("Request body (JSON).");
    }

    const qualifiedName = `${t.id}__${ep.name}`;
    defs[qualifiedName] = tool({
      description: `[${t.metadata.name}${verifiedTag}] ${ep.description} — ${ep.method} ${ep.path}`,
      parameters: z.object(shape),
    });
  }
  return defs;
}

export async function buildToolDefinitions(
  tools: Tool[],
  scope?: ToolBagScope
): Promise<Record<string, ReturnType<typeof tool>>> {
  const credentialEligible = tools.filter(
    (t) => t.mcpServer && hasRequiredCredentials(t.metadata.requires?.credentials)
  );
  // Apply skill-scoped group filter (no-op when scope is permissive).
  const eligibleTools = scope ? filterTools(credentialEligible, scope) : credentialEligible;

  const hash = `${eligibleTools.map((t) => t.id).sort().join(",")}|${scopeSignature(scope)}`;

  if (hash === cachedToolHash && cachedToolDefs) {
    return cachedToolDefs;
  }

  // Dedup concurrent calls — only reuse if building for the same tool set
  if (inflightBuild && inflightBuild.hash === hash) return inflightBuild.promise;

  const buildPromise = doBuild(eligibleTools, tools, hash, scope);
  inflightBuild = { hash, promise: buildPromise };
  try {
    return await buildPromise;
  } finally {
    inflightBuild = null;
  }
}

async function doBuild(
  eligibleTools: Tool[],
  allTools: Tool[],
  hash: string,
  scope?: ToolBagScope,
): Promise<Record<string, ReturnType<typeof tool>>> {
  const toolDefs: Record<string, ReturnType<typeof tool>> = {};
  const discoveredMcpTools = new Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>();
  const failedTools: FailedTool[] = [];
  let hadErrors = false;

  // Synthesized tools — no external discovery; build directly from endpoints frontmatter.
  const synthesizedTools = eligibleTools.filter((t) => t.mcpServer?.transport === "synthesized");
  const externalTools = eligibleTools.filter((t) => t.mcpServer?.transport !== "synthesized");

  for (const t of synthesizedTools) {
    if (!t.endpoints || t.endpoints.length === 0) {
      console.warn(`[tool-builder] synthesized tool ${t.id} has no endpoints — skipping`);
      continue;
    }
    const defs = buildSynthesizedToolDefs(t);
    Object.assign(toolDefs, defs);
    const fakeMcpTools = (t.endpoints ?? []).map((ep: SynthesizedEndpoint) => ({
      name: ep.name,
      description: ep.description,
      inputSchema: {},
    }));
    discoveredMcpTools.set(t.id, fakeMcpTools);
  }

  // Discover MCP tools in parallel — each server is independent
  const results = await Promise.allSettled(
    externalTools.map(async (t) => {
      const mcpTools = await mcpManager.discoverTools(t);
      return { tool: t, mcpTools };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { tool: t, mcpTools } = result.value;
      discoveredMcpTools.set(t.id, mcpTools);

      for (const mcpTool of mcpTools) {
        const qualifiedName = `${t.id}__${mcpTool.name}`;

        toolDefs[qualifiedName] = tool({
          description: `[${t.metadata.name}] ${mcpTool.description}`,
          parameters: jsonSchemaObjectToZod(mcpTool.inputSchema),
        });
      }
    } else {
      hadErrors = true;
      const failedTool = externalTools[results.indexOf(result)];
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logError("mcp_crash", result.reason, { toolId: failedTool?.id });
      console.warn(
        `[tool-builder] failed to discover tools for ${failedTool?.id}:`,
        result.reason
      );
      if (failedTool) {
        failedTools.push({ id: failedTool.id, name: failedTool.metadata.name, reason });
      }
    }
  }

  lastFailedTools = failedTools;

  // Build capability registry from discovered MCP tools + native tools
  buildCapabilityRegistry(eligibleTools, discoveredMcpTools);

  // Log tools that were skipped due to missing credentials
  for (const t of allTools) {
    if (t.mcpServer && !hasRequiredCredentials(t.metadata.requires?.credentials)) {
      console.log(`[tool-builder] skipping ${t.id}: missing required credentials`);
    }
  }

  // Merge native (built-in) tools — also filtered through the scope.
  Object.assign(toolDefs, getNativeToolDefinitions(scope));

  // Apply per-endpoint denied-list (covers synth endpoints whose enclosing
  // tool was kept but specific endpoints should be excluded).
  const finalDefs = scope ? applyScopeToDefs(toolDefs, scope).defs : toolDefs;

  // Only cache if all MCP discoveries succeeded — avoids caching incomplete tool sets
  if (!hadErrors) {
    cachedToolHash = hash;
    cachedToolDefs = finalDefs;
  }
  return finalDefs;
}

/** Invalidate tool definition cache (for repair tool after capability reload). */
export function invalidateToolCache(): void {
  cachedToolHash = null;
  cachedToolDefs = null;
  inflightBuild = null;
  invalidateCapabilityRegistry();
}
