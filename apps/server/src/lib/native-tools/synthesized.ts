import { tool } from "ai";
import { z } from "zod";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Synthesize / repair synthesized tools
// ---------------------------------------------------------------------------

const SYNTHESIZE_TOOL_NAME = "native__synthesize_tool";
const REPAIR_SYNTHESIZED_TOOL_NAME = "native__repair_synthesized_tool";

const synthesizeToolDef = tool({
  description:
    "[Synthesize Tool] Create a callable HTTP tool for an external API after collecting credentials via native__request_credential (ai-research flow). " +
    "Prefer providing an OpenAPI spec URL — the tool will auto-discover endpoints. Fallback: provide a hand-drafted endpoints array. " +
    "This writes a markdown tool file to ~/.chvor/tools/<slug>.md and reloads capabilities immediately. " +
    "After this runs, the tool becomes callable as `<slug>__<endpoint_name>` in your next tool call.",
  parameters: z.object({
    serviceName: z.string().describe("Human-readable service name (e.g. 'Gumroad')."),
    slug: z.string().describe("Slug for the tool — must be kebab-case, used in the tool file path and as toolId prefix (e.g. 'gumroad')."),
    credentialType: z.string().describe("Credential type to bind (e.g. 'gumroad'). Must match the type you saved via native__request_credential."),
    baseUrl: z.string().optional().describe("API base URL, e.g. 'https://api.gumroad.com'. Required if no openApiSpecUrl is provided or if spec discovery fails."),
    authScheme: z.enum(["bearer", "api-key-header", "basic", "query-param", "custom"]).optional().describe("How the API authenticates. Defaults to 'bearer'."),
    openApiSpecUrl: z.string().optional().describe("Direct URL to an OpenAPI/Swagger spec. Preferred — endpoints will be auto-derived."),
    endpoints: z.array(z.object({
      name: z.string().describe("Slug-style endpoint name (lowercase, underscores), e.g. 'list_products'"),
      description: z.string(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().describe("URL path starting with '/', may contain {pathParam} placeholders"),
      pathParams: z.array(z.object({
        name: z.string(),
        type: z.enum(["string", "integer"]).default("string"),
        required: z.boolean().default(true),
      })).optional(),
      queryParams: z.array(z.object({
        name: z.string(),
        type: z.enum(["string", "integer", "boolean"]).default("string"),
        required: z.boolean().default(false),
        description: z.string().optional(),
      })).optional(),
      bodySchema: z.record(z.unknown()).nullable().optional(),
    })).optional().describe("Drafted endpoint set (used when no OpenAPI spec is available)."),
    notes: z.string().optional().describe("Extra notes for the AI / user — becomes the body of the markdown file."),
    credentialId: z.string().optional().describe("Optional saved-credential id to pin this tool to a specific account (when the user has multiple credentials of the same type)."),
    timeoutMs: z.number().int().optional().describe("Optional per-tool HTTP call timeout in milliseconds (min 1000, max 600000). Defaults to 60000."),
  }),
});

const handleSynthesizeTool: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const serviceName = String(args.serviceName);
  const slug = String(args.slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const credentialType = String(args.credentialType);
  const baseUrlArg = args.baseUrl ? String(args.baseUrl) : undefined;
  const authScheme = args.authScheme ? String(args.authScheme) as "bearer" | "api-key-header" | "basic" | "query-param" | "custom" : "bearer";
  const openApiSpecUrl = args.openApiSpecUrl ? String(args.openApiSpecUrl) : undefined;
  const draftedEndpoints = Array.isArray(args.endpoints) ? args.endpoints as Array<Record<string, unknown>> : undefined;
  const notes = args.notes ? String(args.notes) : undefined;
  const credentialIdArg = typeof args.credentialId === "string" ? args.credentialId : undefined;
  const timeoutMsArg = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
    ? Math.min(Math.max(Math.floor(args.timeoutMs), 1_000), 600_000)
    : undefined;

  try {
    const { getCredentialData, listCredentials } = await import("../../db/credential-store.ts");

    // Verify credential exists — honor credentialId pin if provided, else first-of-type.
    const allCreds = listCredentials();
    const cred = credentialIdArg
      ? allCreds.find((c) => c.id === credentialIdArg && c.type === credentialType)
      : allCreds.find((c) => c.type === credentialType);
    if (!cred) {
      const sameType = allCreds.filter((c) => c.type === credentialType);
      if (credentialIdArg && sameType.length > 0) {
        return {
          content: [{
            type: "text",
            text: `No credential with id "${credentialIdArg}" and type "${credentialType}". Available ids of this type: ${sameType.map((c) => c.id).join(", ")}`,
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: `No credential of type "${credentialType}" found. Call native__request_credential first.`,
        }],
      };
    }

    // Try OpenAPI discovery first
    let specSource: "openapi" | "ai-draft" = "ai-draft";
    let verified = false;
    let specUrlUsed: string | undefined;
    let resolvedBaseUrl = baseUrlArg;
    let finalEndpoints: import("@chvor/shared").SynthesizedEndpoint[] = [];

    if (openApiSpecUrl || baseUrlArg) {
      try {
        const { discoverOpenApi, selectOperations } = await import("../spec-fetcher.ts");
        const discovery = await discoverOpenApi({
          serviceName,
          baseUrl: baseUrlArg,
          hintedSpecUrl: openApiSpecUrl,
        });
        if (discovery && discovery.operations.length > 0) {
          specSource = "openapi";
          verified = true;
          specUrlUsed = discovery.specUrl;
          resolvedBaseUrl = discovery.baseUrl ?? baseUrlArg;
          finalEndpoints = selectOperations(discovery.operations, 50);
        }
      } catch (err) {
        console.warn(`[synthesize_tool] OpenAPI discovery failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    if (finalEndpoints.length === 0) {
      // Fall back to drafted endpoints
      if (!draftedEndpoints || draftedEndpoints.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Could not discover OpenAPI spec for "${serviceName}" and no endpoints[] was provided. ` +
              `Provide either openApiSpecUrl or an endpoints array.`,
          }],
        };
      }
      specSource = "ai-draft";
      verified = false;
      finalEndpoints = draftedEndpoints.map((e) => ({
        name: String(e.name),
        description: String(e.description ?? ""),
        method: String(e.method).toUpperCase() as import("@chvor/shared").SynthesizedEndpoint["method"],
        path: String(e.path),
        pathParams: Array.isArray(e.pathParams) ? (e.pathParams as Array<Record<string, unknown>>).map((p) => ({
          name: String(p.name),
          type: (p.type === "integer" ? "integer" : "string") as "string" | "integer",
          required: p.required !== false,
        })) : undefined,
        queryParams: Array.isArray(e.queryParams) ? (e.queryParams as Array<Record<string, unknown>>).map((p) => ({
          name: String(p.name),
          type: (p.type === "integer" ? "integer" : p.type === "boolean" ? "boolean" : "string") as "string" | "integer" | "boolean",
          required: p.required === true,
          description: typeof p.description === "string" ? p.description : undefined,
        })) : undefined,
        bodySchema: e.bodySchema && typeof e.bodySchema === "object" ? e.bodySchema as Record<string, unknown> : null,
      }));
    }

    if (!resolvedBaseUrl) {
      return {
        content: [{
          type: "text",
          text: `Synthesis failed: no baseUrl resolved (provide baseUrl or a working openApiSpecUrl).`,
        }],
      };
    }

    // Persist baseUrl + authScheme into the credential's connectionConfig (single source of truth)
    const credData = getCredentialData(cred.id);
    const existingConfig = credData?.cred.connectionConfig;
    if (!existingConfig || !existingConfig.baseUrl || existingConfig.baseUrl !== resolvedBaseUrl) {
      try {
        const { getDb } = await import("../../db/database.ts");
        const db = getDb();
        const newConfig: import("@chvor/shared").ConnectionConfig = existingConfig ?? {
          auth: { scheme: authScheme },
          baseUrl: resolvedBaseUrl,
          source: specSource === "openapi" ? "probed" : "llm-researched",
          confidence: specSource === "openapi" ? "high" : "medium",
        };
        newConfig.baseUrl = resolvedBaseUrl;
        if (!existingConfig) newConfig.auth = { scheme: authScheme };
        db.prepare("UPDATE credentials SET connection_config = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(newConfig), new Date().toISOString(), cred.id);
      } catch (err) {
        console.warn(`[synthesize_tool] failed to persist connection_config:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Write tool file
    const { writeSynthesizedTool } = await import("../synth-tool-writer.ts");
    const writeResult = writeSynthesizedTool({
      slug,
      name: serviceName,
      description: `${serviceName} API (${specSource === "openapi" ? `OpenAPI-grounded${specUrlUsed ? ", " + specUrlUsed : ""}` : "AI-drafted — unverified"})`,
      credentialType,
      synthesized: {
        source: specSource,
        verified,
        specUrl: specUrlUsed,
        generatedAt: new Date().toISOString(),
        credentialType,
        credentialId: credentialIdArg,
        timeoutMs: timeoutMsArg,
      },
      endpoints: finalEndpoints,
      notes,
    });

    // Reload capabilities + invalidate tool cache so the new tool is pickable next turn
    try {
      const { reloadAll } = await import("../capability-loader.ts");
      reloadAll();
    } catch { /* non-critical */ }
    try {
      const { invalidateToolCache } = await import("../tool-builder.ts");
      invalidateToolCache();
    } catch { /* non-critical */ }

    const endpointList = finalEndpoints.map((e) => `  - ${slug}__${e.name} (${e.method} ${e.path})`).join("\n");
    const verifiedTag = verified ? "verified (OpenAPI-grounded)" : "unverified (AI-drafted)";

    return {
      content: [{
        type: "text",
        text: `Synthesized tool "${slug}" (${verifiedTag}) — ${finalEndpoints.length} endpoints written to ${writeResult.path}.\n` +
          `Base URL: ${resolvedBaseUrl}\n` +
          `Source: ${specSource}${specUrlUsed ? ` (${specUrlUsed})` : ""}\n\n` +
          `Available endpoints:\n${endpointList}\n\n` +
          `Call any endpoint as a tool in your next tool call. ` +
          (verified
            ? `GET calls run without confirmation; non-GET calls prompt the user.`
            : `All calls will prompt the user for confirmation since this is AI-drafted.`),
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: "text",
        text: `Synthesize failed: ${msg}`,
      }],
    };
  }
};

const repairSynthesizedToolDef = tool({
  description:
    "[Repair Synthesized Tool] Re-derive a single endpoint on a synthesized tool after a call failure (wrong path, wrong params, etc). " +
    "Limited to 2 repairs per (tool, endpoint) per session. If the budget is exhausted, ask the user to manually edit ~/.chvor/tools/<slug>.md.",
  parameters: z.object({
    slug: z.string().describe("Slug of the synthesized tool (e.g. 'gumroad')."),
    endpointName: z.string().describe("Endpoint to repair (e.g. 'list_products')."),
    lastError: z.string().describe("The error message from the failed call — helps re-derivation."),
    newEndpoint: z.object({
      description: z.string(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string(),
      pathParams: z.array(z.object({
        name: z.string(),
        type: z.enum(["string", "integer"]).default("string"),
        required: z.boolean().default(true),
      })).optional(),
      queryParams: z.array(z.object({
        name: z.string(),
        type: z.enum(["string", "integer", "boolean"]).default("string"),
        required: z.boolean().default(false),
        description: z.string().optional(),
      })).optional(),
      bodySchema: z.record(z.unknown()).nullable().optional(),
    }).describe("Corrected endpoint definition."),
  }),
});

const handleRepairSynthesizedTool: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> => {
  const slug = String(args.slug);
  const endpointName = String(args.endpointName);
  const lastError = String(args.lastError ?? "");
  const newEp = args.newEndpoint as Record<string, unknown>;

  if (!context?.sessionId) {
    return { content: [{ type: "text", text: "Repair requires an active session." }] };
  }

  const { getRepairAttempts, incrementRepairAttempts, isRepairBudgetExhausted } = await import("../approval-gate.ts");

  if (isRepairBudgetExhausted(context.sessionId, slug, endpointName)) {
    const { count, lastError: prevErr } = getRepairAttempts(context.sessionId, slug, endpointName);
    return {
      content: [{
        type: "text",
        text: `Repair budget exhausted for ${slug}__${endpointName} (${count} attempts this session). ` +
          `Last error: ${prevErr}. Ask the user to edit ~/.chvor/tools/${slug}.md manually, or try a different approach.`,
      }],
    };
  }

  incrementRepairAttempts(context.sessionId, slug, endpointName, lastError);

  const { loadTools } = await import("../capability-loader.ts");
  const synthTool = loadTools().find((t) => t.id === slug && t.mcpServer?.transport === "synthesized");
  if (!synthTool || !synthTool.synthesized || !synthTool.endpoints) {
    return { content: [{ type: "text", text: `Synthesized tool "${slug}" not found.` }] };
  }

  const updatedEndpoint: import("@chvor/shared").SynthesizedEndpoint = {
    name: endpointName,
    description: String(newEp.description ?? ""),
    method: String(newEp.method).toUpperCase() as import("@chvor/shared").SynthesizedEndpoint["method"],
    path: String(newEp.path),
    pathParams: Array.isArray(newEp.pathParams) ? (newEp.pathParams as Array<Record<string, unknown>>).map((p) => ({
      name: String(p.name),
      type: (p.type === "integer" ? "integer" : "string") as "string" | "integer",
      required: p.required !== false,
    })) : undefined,
    queryParams: Array.isArray(newEp.queryParams) ? (newEp.queryParams as Array<Record<string, unknown>>).map((p) => ({
      name: String(p.name),
      type: (p.type === "integer" ? "integer" : p.type === "boolean" ? "boolean" : "string") as "string" | "integer" | "boolean",
      required: p.required === true,
      description: typeof p.description === "string" ? p.description : undefined,
    })) : undefined,
    bodySchema: newEp.bodySchema && typeof newEp.bodySchema === "object" ? newEp.bodySchema as Record<string, unknown> : null,
  };

  const mergedEndpoints = synthTool.endpoints.map((ep) => ep.name === endpointName ? updatedEndpoint : ep);
  if (!mergedEndpoints.some((ep) => ep.name === endpointName)) {
    mergedEndpoints.push(updatedEndpoint);
  }

  try {
    const { writeSynthesizedTool } = await import("../synth-tool-writer.ts");
    writeSynthesizedTool({
      slug,
      name: synthTool.metadata.name,
      description: synthTool.metadata.description,
      credentialType: synthTool.synthesized.credentialType,
      synthesized: { ...synthTool.synthesized, generatedAt: new Date().toISOString() },
      endpoints: mergedEndpoints,
      notes: synthTool.instructions,
    });
    try {
      const { reloadAll } = await import("../capability-loader.ts");
      reloadAll();
    } catch { /* non-critical */ }
    try {
      const { invalidateToolCache } = await import("../tool-builder.ts");
      invalidateToolCache();
    } catch { /* non-critical */ }

    return {
      content: [{
        type: "text",
        text: `Repaired ${slug}__${endpointName} (${updatedEndpoint.method} ${updatedEndpoint.path}). ` +
          `Retry the tool call in your next turn.`,
      }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Repair failed: ${msg}` }] };
  }
};

export const synthesizedModule: NativeToolModule = {
  group: "core",
  criticality: "always-available",
  defs: {
    [SYNTHESIZE_TOOL_NAME]: synthesizeToolDef,
    [REPAIR_SYNTHESIZED_TOOL_NAME]: repairSynthesizedToolDef,
  },
  handlers: {
    [SYNTHESIZE_TOOL_NAME]: handleSynthesizeTool,
    [REPAIR_SYNTHESIZED_TOOL_NAME]: handleRepairSynthesizedTool,
  },
  mappings: {
    [SYNTHESIZE_TOOL_NAME]: { kind: "tool", id: "credentials" },
    [REPAIR_SYNTHESIZED_TOOL_NAME]: { kind: "tool", id: "credentials" },
  },
};
