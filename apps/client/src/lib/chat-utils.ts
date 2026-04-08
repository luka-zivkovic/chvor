/** Human-friendly labels for common native tools. */
const FRIENDLY_NAMES: Record<string, string> = {
  native__web_request: "Web Request",
  native__web_search: "Web Search",
  native__add_credential: "Save Credential",
  native__update_credential: "Update Credential",
  native__list_credentials: "List Credentials",
  native__use_credential: "Use Credential",
  native__delete_credential: "Delete Credential",
  native__test_credential: "Test Credential",
  native__create_schedule: "Create Schedule",
  native__list_schedules: "List Schedules",
  native__delete_schedule: "Delete Schedule",
  native__create_webhook: "Create Webhook",
  native__list_webhooks: "List Webhooks",
  native__delete_webhook: "Delete Webhook",
  native__create_workflow: "Create Workflow",
  native__run_workflow: "Run Workflow",
  native__list_workflows: "List Workflows",
  native__delete_workflow: "Delete Workflow",
  native__create_skill: "Create Skill",
  native__shell_execute: "Run Command",
  native__browser_navigate: "Browse Page",
  native__browser_act: "Browser Action",
  native__browser_extract: "Extract Data",
  native__browser_observe: "Observe Page",
  native__generate_image: "Generate Image",
  native__claude_code: "Code Assistant",
  native__diagnose: "Diagnose",
  native__repair: "Repair",
};

/**
 * Convert an internal tool identifier (e.g. `native__add_credential`)
 * into a human-readable label (e.g. "Save Credential").
 */
export function prettifyToolName(raw: string): string {
  if (FRIENDLY_NAMES[raw]) return FRIENDLY_NAMES[raw];

  // Strip native__ prefix and title-case
  if (raw.startsWith("native__")) {
    return raw
      .slice(8)
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // MCP / registry tools: toolId__toolName → title-case toolName
  const qualifiedMatch = raw.match(/^.+__(.+)$/);
  if (qualifiedMatch) {
    return qualifiedMatch[1]
      .split(/[_-]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Fallback: replace underscores/hyphens and title-case
  return raw
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Strip tool-call artifacts that the LLM sometimes echoes into its text,
 * and truncate overly verbose error messages.
 */
export function sanitizeMessageContent(text: string): string {
  let result = text;

  // Only run native__ regexes when the text actually contains tool artifacts
  if (result.includes("native__")) {
    // Strip native__tool_name(...) invocation patterns the LLM echoes
    result = result.replace(/native__\w+\([^)]*\)/g, "");

    // Strip bare native__tool_name references (not inside backticks/code)
    result = result.replace(/(?<!`)\bnative__\w+\b(?!`)/g, "");
  }

  // Truncate verbose error messages (stay within the same paragraph)
  result = result.replace(
    /Sorry, I encountered an error:\s*[^\n]{150,}/,
    "Sorry, I ran into an issue. Please try again.",
  );

  // Collapse double-spaces and trim orphaned punctuation
  result = result.replace(/ {2,}/g, " ").replace(/^\s*[,;]\s*/gm, "");

  return result.trim();
}
