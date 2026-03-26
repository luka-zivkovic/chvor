import { z } from "zod";
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

function loadCredentials(): { instanceUrl: string; token: string } | null {
  const creds = listCredentials();
  const match = creds.find((c) => c.type === "gitlab");
  if (!match) return null;
  const full = getCredentialData(match.id);
  if (!full) return null;
  const data = full.data as Record<string, string>;
  if (!data.instanceUrl || !data.token) return null;
  return {
    instanceUrl: data.instanceUrl.replace(/\/+$/, ""),
    token: data.token,
  };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function gitlabFetch(
  creds: { instanceUrl: string; token: string },
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${creds.instanceUrl}/api/v4${path}`;
  return fetch(url, {
    ...options,
    headers: {
      "PRIVATE-TOKEN": creds.token,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function getGitlabTools(): ToolDef[] {
  return [
    // ------ list_projects ------
    {
      name: "gitlab_list_projects",
      description:
        "List GitLab projects accessible to the authenticated user. " +
        "Supports filtering by search term and pagination.",
      parameters: z.object({
        search: z.string().optional().describe("Search query to filter projects by name"),
        per_page: z.number().optional().describe("Number of results per page (default 20, max 100)"),
        page: z.number().optional().describe("Page number (default 1)"),
        owned: z.boolean().optional().describe("If true, only return projects owned by the user"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("GitLab credentials not configured. Add instance URL and token in Settings → Connections.");

          const params = new URLSearchParams();
          if (args.search) params.set("search", String(args.search));
          params.set("per_page", String(args.per_page ?? 20));
          params.set("page", String(args.page ?? 1));
          if (args.owned) params.set("owned", "true");
          params.set("order_by", "last_activity_at");

          const resp = await gitlabFetch(creds, `/projects?${params.toString()}`);
          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`GitLab API ${resp.status}: ${body}`);
          }

          const projects = (await resp.json()) as Array<Record<string, unknown>>;
          if (projects.length === 0) {
            return textResult("No projects found.");
          }

          const lines = projects.map((p) =>
            `• ${p.path_with_namespace} (ID: ${p.id})` +
            (p.description ? `\n  ${String(p.description).slice(0, 120)}` : "") +
            `\n  ${p.web_url}`
          );

          const total = resp.headers.get("x-total") ?? "?";
          return textResult(`Projects (page ${args.page ?? 1}, ${total} total):\n\n${lines.join("\n\n")}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ list_issues ------
    {
      name: "gitlab_list_issues",
      description:
        "List issues for a GitLab project. Supports filtering by state, labels, and search.",
      parameters: z.object({
        project_id: z.union([z.number(), z.string()]).describe("Project ID or URL-encoded path (e.g. 'group%2Fproject')"),
        state: z.enum(["opened", "closed", "all"]).optional().describe("Filter by state (default 'opened')"),
        labels: z.string().optional().describe("Comma-separated list of label names"),
        search: z.string().optional().describe("Search issues by title and description"),
        per_page: z.number().optional().describe("Results per page (default 20)"),
        page: z.number().optional().describe("Page number (default 1)"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("GitLab credentials not configured. Add instance URL and token in Settings → Connections.");

          const projectId = encodeURIComponent(String(args.project_id));
          const params = new URLSearchParams();
          params.set("state", String(args.state ?? "opened"));
          if (args.labels) params.set("labels", String(args.labels));
          if (args.search) params.set("search", String(args.search));
          params.set("per_page", String(args.per_page ?? 20));
          params.set("page", String(args.page ?? 1));

          const resp = await gitlabFetch(creds, `/projects/${projectId}/issues?${params.toString()}`);
          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`GitLab API ${resp.status}: ${body}`);
          }

          const issues = (await resp.json()) as Array<Record<string, unknown>>;
          if (issues.length === 0) {
            return textResult("No issues found.");
          }

          const lines = issues.map((i) => {
            const labels = Array.isArray(i.labels) ? (i.labels as string[]).join(", ") : "";
            return (
              `#${i.iid} [${i.state}] ${i.title}` +
              (labels ? `  labels: ${labels}` : "") +
              (i.assignee ? `  assignee: ${(i.assignee as Record<string, unknown>).username}` : "") +
              `\n  ${i.web_url}`
            );
          });

          return textResult(`Issues:\n${lines.join("\n")}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ create_issue ------
    {
      name: "gitlab_create_issue",
      description: "Create a new issue in a GitLab project.",
      parameters: z.object({
        project_id: z.union([z.number(), z.string()]).describe("Project ID or URL-encoded path"),
        title: z.string().describe("Issue title"),
        description: z.string().optional().describe("Issue description (Markdown)"),
        labels: z.string().optional().describe("Comma-separated label names"),
        assignee_ids: z.array(z.number()).optional().describe("Array of user IDs to assign"),
        milestone_id: z.number().optional().describe("Milestone ID"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("GitLab credentials not configured. Add instance URL and token in Settings → Connections.");

          const projectId = encodeURIComponent(String(args.project_id));

          const body: Record<string, unknown> = { title: String(args.title) };
          if (args.description) body.description = String(args.description);
          if (args.labels) body.labels = String(args.labels);
          if (args.assignee_ids) body.assignee_ids = args.assignee_ids;
          if (args.milestone_id) body.milestone_id = args.milestone_id;

          const resp = await gitlabFetch(creds, `/projects/${projectId}/issues`, {
            method: "POST",
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const respBody = await resp.text();
            return errorResult(`GitLab API ${resp.status}: ${respBody}`);
          }

          const issue = (await resp.json()) as Record<string, unknown>;
          return textResult(
            `Created issue #${issue.iid}: ${issue.title}\n${issue.web_url}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ list_mrs ------
    {
      name: "gitlab_list_mrs",
      description:
        "List merge requests for a GitLab project. Supports filtering by state and search.",
      parameters: z.object({
        project_id: z.union([z.number(), z.string()]).describe("Project ID or URL-encoded path"),
        state: z.enum(["opened", "closed", "merged", "all"]).optional().describe("Filter by state (default 'opened')"),
        search: z.string().optional().describe("Search by title or description"),
        per_page: z.number().optional().describe("Results per page (default 20)"),
        page: z.number().optional().describe("Page number (default 1)"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("GitLab credentials not configured. Add instance URL and token in Settings → Connections.");

          const projectId = encodeURIComponent(String(args.project_id));
          const params = new URLSearchParams();
          params.set("state", String(args.state ?? "opened"));
          if (args.search) params.set("search", String(args.search));
          params.set("per_page", String(args.per_page ?? 20));
          params.set("page", String(args.page ?? 1));

          const resp = await gitlabFetch(creds, `/projects/${projectId}/merge_requests?${params.toString()}`);
          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`GitLab API ${resp.status}: ${body}`);
          }

          const mrs = (await resp.json()) as Array<Record<string, unknown>>;
          if (mrs.length === 0) {
            return textResult("No merge requests found.");
          }

          const lines = mrs.map((mr) =>
            `!${mr.iid} [${mr.state}] ${mr.title}` +
            `  ${mr.source_branch} → ${mr.target_branch}` +
            (mr.author ? `  by ${(mr.author as Record<string, unknown>).username}` : "") +
            `\n  ${mr.web_url}`
          );

          return textResult(`Merge requests:\n${lines.join("\n")}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
