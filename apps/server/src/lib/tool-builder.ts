import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "@chvor/shared";
import { logError } from "./error-logger.ts";
import { mcpManager } from "./mcp-manager.ts";
import { hasRequiredCredentials } from "./credential-resolver.ts";
import { getNativeToolDefinitions } from "./native-tools.ts";

/**
 * Convert a JSON Schema properties object to a Zod schema.
 * Handles basic types: string, number, boolean, array, object.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required ?? []) as string[];

  if (Object.keys(properties).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema: z.ZodType;

    switch (prop.type) {
      case "number":
      case "integer":
        fieldSchema = z.number();
        break;
      case "boolean":
        fieldSchema = z.boolean();
        break;
      case "array":
        fieldSchema = z.array(z.unknown());
        break;
      case "object":
        fieldSchema = z.record(z.unknown());
        break;
      default:
        fieldSchema = z.string();
    }

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
let cachedToolHash: string | null = null;
let cachedToolDefs: Record<string, ReturnType<typeof tool>> | null = null;

/**
 * Build Vercel AI SDK tool definitions from loaded tools.
 * Tool names are prefixed: "toolId__mcpToolName" to avoid collisions.
 * No execute callback — orchestrator handles the loop manually.
 * Results are memoized by tool IDs to improve prompt cache hit rates.
 */
export async function buildToolDefinitions(
  tools: Tool[]
): Promise<Record<string, ReturnType<typeof tool>>> {
  const eligibleTools = tools.filter(
    (t) => t.mcpServer && hasRequiredCredentials(t.metadata.requires?.credentials)
  );
  const hash = eligibleTools.map((t) => t.id).sort().join(",");

  if (hash === cachedToolHash && cachedToolDefs) {
    return cachedToolDefs;
  }

  const toolDefs: Record<string, ReturnType<typeof tool>> = {};
  let hadErrors = false;

  for (const t of eligibleTools) {
    try {
      const mcpTools = await mcpManager.discoverTools(t);

      for (const mcpTool of mcpTools) {
        const qualifiedName = `${t.id}__${mcpTool.name}`;

        toolDefs[qualifiedName] = tool({
          description: `[${t.metadata.name}] ${mcpTool.description}`,
          parameters: jsonSchemaToZod(mcpTool.inputSchema),
        });
      }
    } catch (err) {
      hadErrors = true;
      logError("mcp_crash", err, { toolId: t.id });
      console.warn(
        `[tool-builder] failed to discover tools for ${t.id}:`,
        err
      );
    }
  }

  // Log tools that were skipped due to missing credentials
  for (const t of tools) {
    if (t.mcpServer && !hasRequiredCredentials(t.metadata.requires?.credentials)) {
      console.log(`[tool-builder] skipping ${t.id}: missing required credentials`);
    }
  }

  // Merge native (built-in) tools
  Object.assign(toolDefs, getNativeToolDefinitions());

  // Only cache if all MCP discoveries succeeded — avoids caching incomplete tool sets
  if (!hadErrors) {
    cachedToolHash = hash;
    cachedToolDefs = toolDefs;
  }
  return toolDefs;
}

/** Invalidate tool definition cache (for repair tool after capability reload). */
export function invalidateToolCache(): void {
  cachedToolHash = null;
  cachedToolDefs = null;
}
