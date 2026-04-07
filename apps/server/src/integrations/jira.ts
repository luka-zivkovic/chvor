import { z } from "zod";
import { listCredentials, getCredentialData } from "../db/credential-store.ts";
import { assertSafeUrl } from "../lib/url-safety.ts";

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

function loadCredentials(): { domain: string; email: string; apiToken: string } | null {
  const creds = listCredentials();
  const match = creds.find((c) => c.type === "jira");
  if (!match) return null;
  const full = getCredentialData(match.id);
  if (!full) return null;
  const data = full.data as Record<string, string>;
  if (!data.domain || !data.email || !data.apiToken) return null;
  return {
    domain: data.domain.replace(/\/+$/, ""),
    email: data.email,
    apiToken: data.apiToken,
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

function jiraAuthHeader(creds: { email: string; apiToken: string }): string {
  return `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`;
}

async function jiraFetch(
  creds: { domain: string; email: string; apiToken: string },
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${creds.domain}${path}`;
  assertSafeUrl(url, "Jira API URL");
  return fetch(url, {
    ...options,
    headers: {
      Authorization: jiraAuthHeader(creds),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatIssue(issue: Record<string, unknown>): string {
  const fields = issue.fields as Record<string, unknown> | undefined;
  if (!fields) return `${issue.key}: (no fields)`;

  const status = fields.status
    ? (fields.status as Record<string, unknown>).name
    : "Unknown";
  const assignee = fields.assignee
    ? (fields.assignee as Record<string, unknown>).displayName
    : "Unassigned";
  const priority = fields.priority
    ? (fields.priority as Record<string, unknown>).name
    : "None";
  const issueType = fields.issuetype
    ? (fields.issuetype as Record<string, unknown>).name
    : "Unknown";

  return (
    `${issue.key} [${status}] ${fields.summary ?? "(no summary)"}` +
    `\n  Type: ${issueType}  Priority: ${priority}  Assignee: ${assignee}`
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function getJiraTools(): ToolDef[] {
  return [
    // ------ search_issues ------
    {
      name: "jira_search_issues",
      description:
        "Search for Jira issues using JQL (Jira Query Language). " +
        "Returns matching issues with key, summary, status, and assignee.",
      parameters: z.object({
        jql: z.string().describe("JQL query string (e.g. 'project = PROJ AND status = \"In Progress\"')"),
        max_results: z.number().optional().describe("Maximum results to return (default 20, max 50)"),
        start_at: z.number().optional().describe("Index of the first result (for pagination, default 0)"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Fields to include (default: summary, status, assignee, priority, issuetype)"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Jira credentials not configured. Add domain, email, and API token in Settings → Connections.");

          const body = {
            jql: String(args.jql),
            maxResults: Math.min(typeof args.max_results === "number" ? args.max_results : 20, 50),
            startAt: typeof args.start_at === "number" ? args.start_at : 0,
            fields: Array.isArray(args.fields)
              ? args.fields
              : ["summary", "status", "assignee", "priority", "issuetype"],
          };

          const resp = await jiraFetch(creds, "/rest/api/3/search", {
            method: "POST",
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const respBody = await resp.text();
            return errorResult(`Jira API ${resp.status}: ${respBody}`);
          }

          const result = (await resp.json()) as Record<string, unknown>;
          const issues = (result.issues ?? []) as Array<Record<string, unknown>>;
          const total = result.total ?? 0;

          if (issues.length === 0) {
            return textResult("No issues found matching the query.");
          }

          const lines = issues.map(formatIssue);
          return textResult(
            `Found ${total} issue(s) (showing ${issues.length}):\n\n${lines.join("\n\n")}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ get_issue ------
    {
      name: "jira_get_issue",
      description:
        "Get detailed information about a specific Jira issue by its key (e.g. PROJ-123).",
      parameters: z.object({
        issue_key: z.string().describe("Issue key (e.g. 'PROJ-123')"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Fields to include (default: all navigable fields)"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Jira credentials not configured. Add domain, email, and API token in Settings → Connections.");

          const issueKey = String(args.issue_key);
          const params = new URLSearchParams();
          if (Array.isArray(args.fields) && args.fields.length > 0) {
            params.set("fields", (args.fields as string[]).join(","));
          }

          const queryStr = params.toString();
          const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}${queryStr ? `?${queryStr}` : ""}`;
          const resp = await jiraFetch(creds, path);

          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`Jira API ${resp.status}: ${body}`);
          }

          const issue = (await resp.json()) as Record<string, unknown>;
          const fields = issue.fields as Record<string, unknown> | undefined;

          if (!fields) {
            return textResult(`${issue.key}: (no fields returned)`);
          }

          const status = fields.status
            ? (fields.status as Record<string, unknown>).name
            : "Unknown";
          const assignee = fields.assignee
            ? (fields.assignee as Record<string, unknown>).displayName
            : "Unassigned";
          const reporter = fields.reporter
            ? (fields.reporter as Record<string, unknown>).displayName
            : "Unknown";
          const priority = fields.priority
            ? (fields.priority as Record<string, unknown>).name
            : "None";
          const issueType = fields.issuetype
            ? (fields.issuetype as Record<string, unknown>).name
            : "Unknown";
          const created = fields.created ? String(fields.created) : "Unknown";
          const updated = fields.updated ? String(fields.updated) : "Unknown";

          // Description can be Atlassian Document Format — show a simplified version
          let description = "(no description)";
          if (fields.description && typeof fields.description === "object") {
            // ADF — attempt to extract text content
            try {
              description = JSON.stringify(fields.description, null, 2);
              if (description.length > 2000) {
                description = description.slice(0, 2000) + "\n[...truncated]";
              }
            } catch {
              description = "(complex description format)";
            }
          } else if (typeof fields.description === "string") {
            description = fields.description;
          }

          const labels = Array.isArray(fields.labels)
            ? (fields.labels as string[]).join(", ") || "None"
            : "None";

          return textResult(
            `${issue.key}: ${fields.summary ?? "(no summary)"}` +
            `\n\nType: ${issueType}` +
            `\nStatus: ${status}` +
            `\nPriority: ${priority}` +
            `\nAssignee: ${assignee}` +
            `\nReporter: ${reporter}` +
            `\nLabels: ${labels}` +
            `\nCreated: ${created}` +
            `\nUpdated: ${updated}` +
            `\n\nDescription:\n${description}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ create_issue ------
    {
      name: "jira_create_issue",
      description:
        "Create a new Jira issue. Requires a project key and issue type at minimum.",
      parameters: z.object({
        project_key: z.string().describe("Project key (e.g. 'PROJ')"),
        summary: z.string().describe("Issue summary / title"),
        issue_type: z.string().optional().describe("Issue type name (default 'Task'). Common types: Task, Bug, Story, Epic"),
        description: z.string().optional().describe("Plain-text description (will be converted to ADF paragraph)"),
        assignee_id: z.string().optional().describe("Account ID of the assignee"),
        priority: z.string().optional().describe("Priority name (e.g. 'High', 'Medium', 'Low')"),
        labels: z.array(z.string()).optional().describe("Labels to add to the issue"),
        parent_key: z.string().optional().describe("Parent issue key for subtasks (e.g. 'PROJ-100')"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Jira credentials not configured. Add domain, email, and API token in Settings → Connections.");

          const fields: Record<string, unknown> = {
            project: { key: String(args.project_key) },
            summary: String(args.summary),
            issuetype: { name: String(args.issue_type ?? "Task") },
          };

          if (args.description) {
            // Convert plain text to ADF paragraph
            fields.description = {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: String(args.description) }],
                },
              ],
            };
          }

          if (args.assignee_id) {
            fields.assignee = { id: String(args.assignee_id) };
          }
          if (args.priority) {
            fields.priority = { name: String(args.priority) };
          }
          if (Array.isArray(args.labels)) {
            fields.labels = args.labels;
          }
          if (args.parent_key) {
            fields.parent = { key: String(args.parent_key) };
          }

          const resp = await jiraFetch(creds, "/rest/api/3/issue", {
            method: "POST",
            body: JSON.stringify({ fields }),
          });

          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`Jira API ${resp.status}: ${body}`);
          }

          const created = (await resp.json()) as Record<string, unknown>;
          return textResult(
            `Created issue ${created.key}: ${args.summary}\n${creds.domain}/browse/${created.key}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ update_issue ------
    {
      name: "jira_update_issue",
      description:
        "Update fields on an existing Jira issue. Only provided fields will be changed.",
      parameters: z.object({
        issue_key: z.string().describe("Issue key (e.g. 'PROJ-123')"),
        summary: z.string().optional().describe("New summary / title"),
        description: z.string().optional().describe("New plain-text description"),
        assignee_id: z.string().optional().describe("Account ID of the new assignee (use empty string to unassign)"),
        priority: z.string().optional().describe("New priority name"),
        labels: z.array(z.string()).optional().describe("Replace all labels with this list"),
        status: z.string().optional().describe("Transition to this status name (e.g. 'Done', 'In Progress')"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Jira credentials not configured. Add domain, email, and API token in Settings → Connections.");

          const issueKey = String(args.issue_key);
          const fields: Record<string, unknown> = {};

          if (args.summary !== undefined) {
            fields.summary = String(args.summary);
          }
          if (args.description !== undefined) {
            fields.description = {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: String(args.description) }],
                },
              ],
            };
          }
          if (args.assignee_id !== undefined) {
            fields.assignee = args.assignee_id === ""
              ? null
              : { id: String(args.assignee_id) };
          }
          if (args.priority !== undefined) {
            fields.priority = { name: String(args.priority) };
          }
          if (args.labels !== undefined) {
            fields.labels = args.labels;
          }

          // Handle status transitions separately
          if (args.status !== undefined) {
            // First, get available transitions
            const transResp = await jiraFetch(
              creds,
              `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
            );
            if (!transResp.ok) {
              const transBody = await transResp.text();
              return errorResult(`Failed to fetch transitions for ${issueKey}: Jira API ${transResp.status}: ${transBody}`);
            }
            const transData = (await transResp.json()) as Record<string, unknown>;
            const transitions = (transData.transitions ?? []) as Array<Record<string, unknown>>;
            const target = transitions.find(
              (t) =>
                (t.name as string).toLowerCase() === String(args.status).toLowerCase() ||
                ((t.to as Record<string, unknown>)?.name as string)?.toLowerCase() === String(args.status).toLowerCase()
            );
            if (target) {
              const doTransResp = await jiraFetch(
                creds,
                `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
                {
                  method: "POST",
                  body: JSON.stringify({ transition: { id: target.id } }),
                }
              );
              if (!doTransResp.ok) {
                const doTransBody = await doTransResp.text();
                return errorResult(`Failed to transition ${issueKey} to "${args.status}": Jira API ${doTransResp.status}: ${doTransBody}`);
              }
            } else {
              const available = transitions
                .map((t) => `"${(t.to as Record<string, unknown>)?.name ?? t.name}"`)
                .join(", ");
              return errorResult(
                `Cannot transition to "${args.status}". Available transitions: ${available}`
              );
            }
          }

          // Update fields if any were provided
          if (Object.keys(fields).length > 0) {
            const resp = await jiraFetch(
              creds,
              `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
              {
                method: "PUT",
                body: JSON.stringify({ fields }),
              }
            );

            if (!resp.ok) {
              const body = await resp.text();
              return errorResult(`Jira API ${resp.status}: ${body}`);
            }
          }

          const updatedParts: string[] = [];
          if (args.summary !== undefined) updatedParts.push("summary");
          if (args.description !== undefined) updatedParts.push("description");
          if (args.assignee_id !== undefined) updatedParts.push("assignee");
          if (args.priority !== undefined) updatedParts.push("priority");
          if (args.labels !== undefined) updatedParts.push("labels");
          if (args.status !== undefined) updatedParts.push(`status → ${args.status}`);

          return textResult(
            `Updated ${issueKey}: ${updatedParts.join(", ")}\n${creds.domain}/browse/${issueKey}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
