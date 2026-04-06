/**
 * Maps Composio MCP tool names (e.g. TWITTER_CREATE_TWEET) to abstract
 * capability IDs (e.g. twitter:post) using a convention-based parser with
 * explicit overrides for known inconsistencies.
 */

// ---------------------------------------------------------------------------
// Explicit overrides — handles Composio naming inconsistencies
// ---------------------------------------------------------------------------

const EXPLICIT_MAP: Record<string, string> = {
  // Twitter / X
  TWITTER_CREATE_TWEET: "twitter:post",
  TWITTER_CREATION_OF_A_TWEET: "twitter:post",
  TWITTER_CREATION_OF_A_TWEET_V2: "twitter:post",
  TWITTER_CREATE_A_TWEET: "twitter:post",
  TWITTER_REPLY_TO_TWEET: "twitter:reply",
  TWITTER_GET_USER_TIMELINE: "twitter:read-timeline",
  TWITTER_RETWEET: "twitter:retweet",

  // LinkedIn
  LINKEDIN_CREATE_POST: "linkedin:post",
  LINKEDIN_CREATE_A_LINKEDIN_POST: "linkedin:post",
  LINKEDIN_CREATE_A_POST: "linkedin:post",
  LINKEDIN_COMMENT_ON_POST: "linkedin:comment",

  // Reddit
  REDDIT_SUBMIT_POST: "reddit:submit",
  REDDIT_SUBMIT_A_POST: "reddit:submit",
  REDDIT_GET_SUBREDDIT_POSTS: "reddit:read-posts",
  REDDIT_SUBMIT_COMMENT: "reddit:comment",

  // Instagram
  INSTAGRAM_CREATE_MEDIA: "instagram:post",
  INSTAGRAM_CREATE_A_MEDIA: "instagram:post",

  // Gmail
  GMAIL_SEND_EMAIL: "gmail:send",
  GMAIL_CREATE_EMAIL_DRAFT: "gmail:draft",

  // Slack
  SLACK_SEND_MESSAGE: "slack:send-message",
  SLACK_SEND_A_MESSAGE: "slack:send-message",

  // GitHub
  GITHUB_CREATE_ISSUE: "github:create-issue",
  GITHUB_CREATE_A_PULL_REQUEST: "github:create-pr",

  // WordPress
  WORDPRESS_CREATE_POST: "wordpress:create-post",
  WORDPRESS_CREATE_A_POST: "wordpress:create-post",

  // Notion
  NOTION_CREATE_PAGE: "notion:create-page",
  NOTION_CREATE_A_PAGE: "notion:create-page",
};

// ---------------------------------------------------------------------------
// Action normalization rules for convention-based fallback
// ---------------------------------------------------------------------------

const ACTION_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/^CREATE_(?:A_)?TWEET$/, "post"],
  [/^CREATE_(?:A_)?POST$/, "post"],
  [/^SUBMIT_(?:A_)?POST$/, "submit"],
  [/^CREATE_(?:A_)?MEDIA$/, "post"],
  [/^SEND_(?:A_)?EMAIL$/, "send"],
  [/^SEND_(?:A_)?MESSAGE$/, "send-message"],
  [/^CREATE_(?:A_)?DRAFT$/, "draft"],
  [/^CREATE_(?:A_)?ISSUE$/, "create-issue"],
  [/^CREATE_(?:A_)?PULL_REQUEST$/, "create-pr"],
  [/^CREATE_(?:A_)?PAGE$/, "create-page"],
  [/^CREATE_(?:A_)?COMMENT$/, "comment"],
  [/^SUBMIT_(?:A_)?COMMENT$/, "comment"],
  [/^COMMENT_ON_.*$/, "comment"],
  [/^REPLY_TO_.*$/, "reply"],
  [/^GET_.*TIMELINE$/, "read-timeline"],
  [/^GET_.*POSTS$/, "read-posts"],
  [/^GET_.*MESSAGES$/, "read-messages"],
  [/^SEARCH_.*$/, "search"],
  [/^DELETE_.*$/, "delete"],
  [/^UPDATE_.*$/, "update"],
  [/^LIST_.*$/, "list"],
  [/^RETWEET$/, "retweet"],
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a Composio MCP tool name to a capability ID.
 *
 * Strategy:
 * 1. Check explicit override map
 * 2. Extract platform prefix, normalize action via rules
 * 3. Fall back to raw lowercase-hyphenated action
 *
 * Returns null only if the name has no underscore (can't extract platform).
 */
export function mapComposioToolName(mcpToolName: string): string | null {
  // 1. Explicit override
  if (EXPLICIT_MAP[mcpToolName]) {
    return EXPLICIT_MAP[mcpToolName];
  }

  // 2. Convention-based: PLATFORM_ACTION_WORDS
  const firstUnderscore = mcpToolName.indexOf("_");
  if (firstUnderscore === -1) return null;

  const platform = mcpToolName.slice(0, firstUnderscore).toLowerCase();
  const actionRaw = mcpToolName.slice(firstUnderscore + 1);

  // Try normalization rules
  for (const [pattern, action] of ACTION_NORMALIZATIONS) {
    if (pattern.test(actionRaw)) {
      return `${platform}:${action}`;
    }
  }

  // 3. Fallback: lowercase and hyphenate
  const action = actionRaw
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/^a-/, ""); // strip leading "a-" from "A_POST" → "a-post"
  return `${platform}:${action}`;
}
