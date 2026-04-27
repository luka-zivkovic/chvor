import { tool } from "ai";
import { z } from "zod";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Switch Model tool
// ---------------------------------------------------------------------------

const SWITCH_MODEL_NAME = "native__switch_model";

const switchModelToolDef = tool({
  description:
    "[Switch Model] Change which AI model is used for conversations. " +
    "Use `action: \"list\"` to see available providers and models. " +
    "Use `action: \"switch\"` with a provider and model to change. " +
    "Use `action: \"rollback\"` to revert to the previous model if something goes wrong. " +
    "Rollback supports one level only and is not persisted across restarts. " +
    "The switch takes effect starting from the next message.",
  parameters: z.object({
    action: z.enum(["list", "switch", "rollback"]).describe("list = show available models, switch = change model, rollback = revert to previous"),
    providerId: z.string().optional().describe("Provider ID (e.g. 'anthropic', 'openai', 'google')"),
    model: z.string().optional().describe("Model ID (e.g. 'claude-sonnet-4-6', 'gpt-4o')"),
    role: z.enum(["primary", "reasoning", "lightweight", "heartbeat"]).optional()
      .describe("Which role to change. Defaults to 'primary'."),
  }),
});

// Store previous config per role for rollback
const _previousModelConfigs = new Map<string, { providerId: string; model: string }>();

const handleSwitchModel: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  const action = args.action as string;
  const role = (args.role as string) ?? "primary";

  if (action === "list") {
    const { fetchModelsForProvider } = await import("../model-fetcher.ts");
    const { LLM_PROVIDERS } = await import("../provider-registry.ts");
    const { listCredentials } = await import("../../db/credential-store.ts");
    const { getRoleConfig } = await import("../../db/config-store.ts");

    const creds = listCredentials();
    const current = getRoleConfig(role as import("@chvor/shared").ModelRole);
    const lines: string[] = [];

    if (current) {
      lines.push(`Current ${role} model: ${current.providerId}/${current.model}`);
    } else {
      lines.push(`No ${role} model configured (using auto-detect).`);
    }
    lines.push("", "Available providers and models:");

    for (const p of LLM_PROVIDERS) {
      const hasCred = creds.some(
        (c) => c.type === p.credentialType && c.testStatus === "success",
      );
      if (!hasCred) continue;
      const { models } = await fetchModelsForProvider(p.id);
      if (models.length === 0) {
        lines.push(`- ${p.id}: (free-text — type any model name)`);
      } else {
        const modelList = models.slice(0, 10).map((m) => m.id).join(", ");
        const more = models.length > 10 ? ` (+${models.length - 10} more)` : "";
        lines.push(`- ${p.id}: ${modelList}${more}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (action === "switch") {
    const providerId = args.providerId as string;
    const model = args.model as string;
    if (!providerId || !model) {
      return {
        content: [{ type: "text", text: "Error: providerId and model are required for switch action." }],
      };
    }

    const { LLM_PROVIDERS } = await import("../provider-registry.ts");
    const { listCredentials } = await import("../../db/credential-store.ts");
    const { setRoleConfig, getRoleConfig } = await import("../../db/config-store.ts");
    const { fetchModelsForProvider } = await import("../model-fetcher.ts");

    // Validate provider exists
    const provDef = LLM_PROVIDERS.find((p) => p.id === providerId);
    if (!provDef) {
      const available = LLM_PROVIDERS.map((p) => p.id).join(", ");
      return {
        content: [{ type: "text", text: `Unknown provider: "${providerId}". Available: ${available}` }],
      };
    }

    // Validate credential exists
    const creds = listCredentials();
    const hasCred = creds.some(
      (c) => c.type === provDef.credentialType && c.testStatus !== "failed",
    );
    if (!hasCred) {
      return {
        content: [{ type: "text", text: `No valid credential for ${providerId}. Add one first.` }],
      };
    }

    // Pre-flight: check model exists in provider's model list (when available)
    const { models: availableModels } = await fetchModelsForProvider(providerId);
    if (availableModels.length > 0 && !availableModels.some((m) => m.id === model)) {
      const suggestions = availableModels.slice(0, 8).map((m) => m.id).join(", ");
      return {
        content: [
          { type: "text", text: `Model "${model}" not found for ${providerId}. Available: ${suggestions}` },
        ],
      };
    }

    // Save previous config for rollback
    const prev = getRoleConfig(role as import("@chvor/shared").ModelRole);
    if (prev) _previousModelConfigs.set(role, prev);

    setRoleConfig(role as import("@chvor/shared").ModelRole, providerId, model);
    return {
      content: [
        {
          type: "text",
          text: `Switched ${role} model to ${providerId}/${model}. Takes effect on next message.${prev ? ` Previous: ${prev.providerId}/${prev.model} (use "rollback" to revert).` : ""}`,
        },
      ],
    };
  }

  if (action === "rollback") {
    const { setRoleConfig } = await import("../../db/config-store.ts");
    const prev = _previousModelConfigs.get(role);
    if (!prev) {
      return {
        content: [{ type: "text", text: `No previous ${role} config to roll back to.` }],
      };
    }
    setRoleConfig(role as import("@chvor/shared").ModelRole, prev.providerId, prev.model);
    _previousModelConfigs.delete(role);
    return {
      content: [
        { type: "text", text: `Rolled back ${role} model to ${prev.providerId}/${prev.model}.` },
      ],
    };
  }

  return {
    content: [{ type: "text", text: "Unknown action. Use 'list', 'switch', or 'rollback'." }],
  };
};

export const modelModule: NativeToolModule = {
  group: "model",
  defs: { [SWITCH_MODEL_NAME]: switchModelToolDef },
  handlers: { [SWITCH_MODEL_NAME]: handleSwitchModel },
  mappings: { [SWITCH_MODEL_NAME]: { kind: "tool", id: "models" } },
};
