import { tool } from "ai";
import { z } from "zod";
import type { RegistryEntryKind } from "@chvor/shared";
import { fetchRegistryIndex, readCachedIndex } from "../registry-client.ts";
import { installEntry, uninstallEntry, readLock } from "../registry-manager.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Registry: Search, Install, Uninstall
// ---------------------------------------------------------------------------

const REGISTRY_SEARCH_NAME = "native__registry_search";
const registrySearchToolDef = tool({
  description:
    "[Registry] Search the skill & tool registry. Use when the user asks to find, browse, or list available skills, tools, or templates from the registry.",
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe("Search query to match against name, description, id, or tags"),
    kind: z
      .enum(["skill", "tool", "template"])
      .optional()
      .describe("Filter by entry kind"),
    category: z.string().optional().describe("Filter by category"),
  }),
});

const handleRegistrySearch: NativeToolHandler = async (
  args: Record<string, unknown>,
): Promise<NativeToolResult> => {
  try {
    const query = (args.query as string | undefined)?.toLowerCase() ?? "";
    const kind = args.kind as RegistryEntryKind | undefined;
    const category = args.category as string | undefined;

    let index: Awaited<ReturnType<typeof fetchRegistryIndex>>;
    try {
      index = await fetchRegistryIndex();
    } catch {
      const cached = readCachedIndex();
      if (!cached) throw new Error("Registry unavailable and no cached index exists");
      index = cached;
    }

    let results = index.entries;

    if (kind) {
      results = results.filter((e) => e.kind === kind);
    }

    if (query) {
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          e.id.toLowerCase().includes(query) ||
          e.tags?.some((t) => t.toLowerCase().includes(query)),
      );
    }

    if (category) {
      results = results.filter((e) => e.category === category);
    }

    const lock = readLock();
    const lines = results.map((e, i) => {
      const installed = lock.installed[e.id];
      const status = installed ? " [installed]" : "";
      return `${i + 1}. **${e.name}** (${e.kind}) v${e.version} — ${e.description}${status}\n   id: \`${e.id}\``;
    });

    const summary =
      results.length === 0
        ? `No registry entries found${query ? ` matching "${query}"` : ""}.`
        : `Found ${results.length} registry ${results.length === 1 ? "entry" : "entries"}${query ? ` matching "${query}"` : ""}:\n\n${lines.join("\n")}`;

    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Registry search failed: ${msg}` }],
    };
  }
};

const REGISTRY_INSTALL_NAME = "native__registry_install";
const registryInstallToolDef = tool({
  description:
    "[Registry] Install a skill or tool from the registry by its ID. Use when the user asks to install, add, or enable a registry entry. Search first if you only have a name, not an ID.",
  parameters: z.object({
    id: z.string().describe("The registry entry ID to install (e.g. 'web-scraper')"),
    kind: z
      .enum(["skill", "tool", "template"])
      .optional()
      .describe("Entry kind — auto-detected if omitted"),
  }),
});

const handleRegistryInstall: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> => {
  try {
    if (!args.id || typeof args.id !== "string") {
      return { content: [{ type: "text", text: "Registry install failed: 'id' is required." }] };
    }
    const id = args.id;
    const kind = args.kind as RegistryEntryKind | undefined;

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.invoked",
        data: { nodeId: `tool-registry`, toolId: "registry" },
      });
    }

    const result = await installEntry(id, kind);
    const depInfo =
      result.dependencies.length > 0
        ? `\nDependencies installed: ${result.dependencies.join(", ")}`
        : "";
    const failedInfo =
      result.failedDependencies.length > 0
        ? `\nFailed dependencies: ${result.failedDependencies.join(", ")}`
        : "";

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.completed",
        data: { nodeId: `tool-registry`, output: `Installed ${id}` },
      });
    }

    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "skills.reloaded", data: {} });

    return {
      content: [
        {
          type: "text",
          text: `Successfully installed **${result.installed.metadata.name}** (${result.installed.kind}) v${result.installed.metadata.version}.${depInfo}${failedInfo}`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.failed",
        data: { nodeId: `tool-registry`, error: msg },
      });
    }
    return {
      content: [{ type: "text", text: `Registry install failed: ${msg}` }],
    };
  }
};

const REGISTRY_UNINSTALL_NAME = "native__registry_uninstall";
const registryUninstallToolDef = tool({
  description:
    "[Registry] Uninstall a skill or tool by its ID. Use when the user asks to remove, uninstall, or disable a registry entry.",
  parameters: z.object({
    id: z.string().describe("The registry entry ID to uninstall"),
  }),
});

const handleRegistryUninstall: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext,
): Promise<NativeToolResult> => {
  try {
    if (!args.id || typeof args.id !== "string") {
      return { content: [{ type: "text", text: "Registry uninstall failed: 'id' is required." }] };
    }
    const id = args.id;

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.invoked",
        data: { nodeId: `tool-registry`, toolId: "registry" },
      });
    }

    await uninstallEntry(id);

    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.completed",
        data: { nodeId: `tool-registry`, output: `Uninstalled ${id}` },
      });
    }

    const { getWSInstance } = await import("../../gateway/ws-instance.ts");
    getWSInstance()?.broadcast({ type: "skills.reloaded", data: {} });

    return {
      content: [
        { type: "text", text: `Successfully uninstalled **${id}** from the registry.` },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (context?.emitEvent) {
      context.emitEvent({
        type: "tool.failed",
        data: { nodeId: `tool-registry`, error: msg },
      });
    }
    return {
      content: [{ type: "text", text: `Registry uninstall failed: ${msg}` }],
    };
  }
};

export const registryModule: NativeToolModule = {
  group: "registry",
  defs: {
    [REGISTRY_SEARCH_NAME]: registrySearchToolDef,
    [REGISTRY_INSTALL_NAME]: registryInstallToolDef,
    [REGISTRY_UNINSTALL_NAME]: registryUninstallToolDef,
  },
  handlers: {
    [REGISTRY_SEARCH_NAME]: handleRegistrySearch,
    [REGISTRY_INSTALL_NAME]: handleRegistryInstall,
    [REGISTRY_UNINSTALL_NAME]: handleRegistryUninstall,
  },
  mappings: {
    [REGISTRY_SEARCH_NAME]: { kind: "tool", id: "registry" },
    [REGISTRY_INSTALL_NAME]: { kind: "tool", id: "registry" },
    [REGISTRY_UNINSTALL_NAME]: { kind: "tool", id: "registry" },
  },
};
