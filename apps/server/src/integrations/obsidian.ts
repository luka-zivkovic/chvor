import { z } from "zod";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, relative, normalize } from "node:path";
import { listCredentials, getCredentialData } from "../db/credential-store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodObject<any>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function loadCredentials(): { vaultPath: string } | null {
  const creds = listCredentials();
  const match = creds.find((c) => c.type === "obsidian");
  if (!match) return null;
  const full = getCredentialData(match.id);
  if (!full) return null;
  const data = full.data as Record<string, string>;
  if (!data.vaultPath) return null;
  return { vaultPath: data.vaultPath };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

/** Ensure the resolved path is within the vault root to prevent path traversal. */
function assertWithinVault(vaultPath: string, targetPath: string): string {
  const root = resolve(vaultPath);
  const full = resolve(root, normalize(targetPath));
  const rootWithSep = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new Error("Path is outside the vault directory");
  }
  return full;
}

/** Recursively list all .md files under a directory. */
async function walkMarkdown(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden directories and .obsidian config dir
      if (entry.name.startsWith(".")) continue;
      results.push(...(await walkMarkdown(fullPath)));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function getObsidianTools(): ToolDef[] {
  return [
    // ------ search_notes ------
    {
      name: "obsidian_search_notes",
      description:
        "Search for Markdown notes in the Obsidian vault. " +
        "Returns file paths (relative to vault root) that match an optional query string.",
      parameters: z.object({
        query: z
          .string()
          .optional()
          .describe("Text to search for inside notes. If omitted, all notes are listed."),
        max_results: z
          .number()
          .optional()
          .describe("Maximum number of results to return (default 50)"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Obsidian credentials not configured. Add a vault path in Settings → Connections.");

          const vaultRoot = resolve(creds.vaultPath);
          const query = args.query != null ? String(args.query).toLowerCase() : null;
          const maxResults = typeof args.max_results === "number" ? args.max_results : 50;

          const allFiles = await walkMarkdown(vaultRoot);
          const matches: Array<{ path: string; snippet?: string }> = [];

          for (const filePath of allFiles) {
            if (matches.length >= maxResults) break;
            const relPath = relative(vaultRoot, filePath);

            if (!query) {
              matches.push({ path: relPath });
              continue;
            }

            // Check filename match
            if (relPath.toLowerCase().includes(query)) {
              matches.push({ path: relPath });
              continue;
            }

            // Grep file contents
            try {
              const content = await readFile(filePath, "utf-8");
              const idx = content.toLowerCase().indexOf(query);
              if (idx !== -1) {
                const start = Math.max(0, idx - 60);
                const end = Math.min(content.length, idx + query.length + 60);
                const snippet = content.slice(start, end).replace(/\n/g, " ");
                matches.push({ path: relPath, snippet });
              }
            } catch {
              // skip unreadable files
            }
          }

          if (matches.length === 0) {
            return textResult(query ? `No notes found matching "${args.query}".` : "No notes found in the vault.");
          }

          const lines = matches.map((m) =>
            m.snippet ? `${m.path}  — …${m.snippet}…` : m.path
          );
          return textResult(`Found ${matches.length} note(s):\n${lines.join("\n")}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ read_note ------
    {
      name: "obsidian_read_note",
      description:
        "Read the contents of a Markdown note from the Obsidian vault by its path relative to the vault root.",
      parameters: z.object({
        path: z.string().describe("File path relative to the vault root (e.g. 'Daily/2026-03-17.md')"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Obsidian credentials not configured. Add a vault path in Settings → Connections.");

          const filePath = assertWithinVault(creds.vaultPath, String(args.path));
          const content = await readFile(filePath, "utf-8");
          return textResult(content);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ create_note ------
    {
      name: "obsidian_create_note",
      description:
        "Create a new Markdown note in the Obsidian vault. Fails if the file already exists.",
      parameters: z.object({
        path: z.string().describe("File path relative to the vault root (must end in .md)"),
        content: z.string().describe("Markdown content for the new note"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Obsidian credentials not configured. Add a vault path in Settings → Connections.");

          const notePath = String(args.path);
          if (!notePath.endsWith(".md")) {
            return errorResult("Path must end with .md");
          }

          const filePath = assertWithinVault(creds.vaultPath, notePath);

          // Check if file already exists
          try {
            await stat(filePath);
            return errorResult(`Note already exists at "${notePath}". Use obsidian_update_note to modify it.`);
          } catch {
            // File does not exist — proceed
          }

          // Ensure parent directory exists
          const { mkdir } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(filePath), { recursive: true });

          await writeFile(filePath, String(args.content), "utf-8");
          return textResult(`Created note: ${notePath}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ update_note ------
    {
      name: "obsidian_update_note",
      description:
        "Update (overwrite) an existing Markdown note in the Obsidian vault.",
      parameters: z.object({
        path: z.string().describe("File path relative to the vault root"),
        content: z.string().describe("New Markdown content to write"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Obsidian credentials not configured. Add a vault path in Settings → Connections.");

          const filePath = assertWithinVault(creds.vaultPath, String(args.path));

          // Verify the file exists before overwriting
          try {
            await stat(filePath);
          } catch {
            return errorResult(`Note not found: "${args.path}". Use obsidian_create_note to create it.`);
          }

          await writeFile(filePath, String(args.content), "utf-8");
          return textResult(`Updated note: ${args.path}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
