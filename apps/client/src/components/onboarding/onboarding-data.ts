import type { CredentialType } from "@chvor/shared";

export interface SkillEntry {
  id: string;
  label: string;
  description: string;
  category: "communication" | "knowledge" | "devtools" | "productivity" | "life" | "builtin";
  icon?: string;
  credType?: CredentialType;
  comingSoon?: boolean;
  featured?: boolean;
  /** OAuth provider ID (matches OAUTH_PROVIDERS in provider-registry) */
  oauthProvider?: string;
  /** OAuth connection method — "direct" needs no third-party, "composio" requires Composio key */
  oauthMethod?: "direct" | "composio";
}

export const CATEGORY_LABELS: Record<SkillEntry["category"], string> = {
  communication: "Communication",
  knowledge: "Knowledge & Docs",
  devtools: "Developer Tools",
  productivity: "Productivity",
  life: "Smart Home & Life",
  builtin: "Built-in",
};

export const CATEGORY_ORDER: SkillEntry["category"][] = [
  "communication", "knowledge", "devtools", "productivity", "life", "builtin",
];

export const SKILL_CATALOG: SkillEntry[] = [
  // --- Communication ---
  { id: "telegram", label: "Telegram", description: "Chat with your AI from Telegram", category: "communication", credType: "telegram", featured: true },
  { id: "discord", label: "Discord", description: "Bring your AI into Discord servers", category: "communication", credType: "discord", featured: true },
  { id: "slack", label: "Slack", description: "Connect via Slack Socket Mode", category: "communication", credType: "slack" },
  { id: "whatsapp", label: "WhatsApp", description: "Chat with your AI from WhatsApp", category: "communication", credType: "whatsapp", featured: true },
  { id: "matrix", label: "Matrix", description: "Connect via Matrix/Element", category: "communication", credType: "matrix" },
  { id: "signal", label: "Signal", description: "Private messaging with Signal", category: "communication", comingSoon: true },
  { id: "teams", label: "Microsoft Teams", description: "Integrate with Teams workspaces", category: "communication", comingSoon: true },
  { id: "imessage", label: "iMessage", description: "Chat via Apple iMessage", category: "communication", comingSoon: true },

  // --- Knowledge & Docs ---
  { id: "obsidian", label: "Obsidian", description: "Read and write notes in your vault", category: "knowledge", credType: "obsidian", featured: true },
  { id: "notion", label: "Notion", description: "Query and update Notion pages and databases", category: "knowledge", icon: "notion", credType: "notion", featured: true },
  { id: "confluence", label: "Confluence", description: "Search and read Confluence spaces", category: "knowledge", comingSoon: true },
  { id: "readwise", label: "Readwise", description: "Access highlights and annotations", category: "knowledge", comingSoon: true },
  { id: "evernote", label: "Evernote", description: "Search and manage Evernote notes", category: "knowledge", comingSoon: true },
  { id: "pocket", label: "Pocket", description: "Access saved articles and bookmarks", category: "knowledge", comingSoon: true },

  // --- Developer Tools ---
  { id: "github", label: "GitHub", description: "Repos, issues, PRs, and code search", category: "devtools", icon: "github", credType: "github", featured: true },
  { id: "gitlab", label: "GitLab", description: "Projects, issues, MRs, and code search", category: "devtools", credType: "gitlab" },
  { id: "jira", label: "Jira", description: "Search, create, and manage issues", category: "devtools", credType: "jira" },
  { id: "context7", label: "Context7", description: "Real-time library docs and code examples", category: "devtools", icon: "context7" },
  { id: "git", label: "Git", description: "Read git history, diffs, and branches", category: "devtools", comingSoon: true },
  { id: "sentry", label: "Sentry", description: "Query errors and performance issues", category: "devtools", comingSoon: true },
  { id: "postgres", label: "PostgreSQL", description: "Query and manage Postgres databases", category: "devtools", comingSoon: true },
  { id: "bitbucket", label: "Bitbucket", description: "Repos, PRs, and pipelines", category: "devtools", comingSoon: true },
  { id: "vercel", label: "Vercel", description: "Deployments, domains, and logs", category: "devtools", comingSoon: true },

  // --- Productivity ---
  { id: "gmail", label: "Gmail", description: "Read, search, and send emails", category: "productivity", oauthProvider: "google", oauthMethod: "direct", featured: true },
  { id: "google-calendar", label: "Google Calendar", description: "View, create, and manage events", category: "productivity", oauthProvider: "google", oauthMethod: "direct" },
  { id: "google-drive", label: "Google Drive", description: "Search, read, and organize files", category: "productivity", oauthProvider: "google", oauthMethod: "direct" },
  { id: "linear", label: "Linear", description: "Create and manage issues and projects", category: "productivity", comingSoon: true },
  { id: "todoist", label: "Todoist", description: "Manage tasks and to-do lists", category: "productivity", comingSoon: true },
  { id: "dropbox", label: "Dropbox", description: "Access and manage cloud files", category: "productivity", comingSoon: true },
  { id: "onedrive", label: "OneDrive", description: "Access Microsoft cloud storage", category: "productivity", comingSoon: true },

  // --- Social (via OAuth) ---
  { id: "twitter", label: "Twitter / X", description: "Post tweets, read timeline, and manage your account", category: "communication", oauthProvider: "twitter", oauthMethod: "composio" },
  { id: "reddit", label: "Reddit", description: "Browse, post, and message on Reddit", category: "communication", oauthProvider: "reddit", oauthMethod: "direct" },
  { id: "linkedin", label: "LinkedIn", description: "Post updates and manage your profile", category: "communication", oauthProvider: "linkedin", oauthMethod: "composio" },

  // --- Smart Home & Life ---
  { id: "homeassistant", label: "Home Assistant", description: "Control smart home devices and automations", category: "life", credType: "homeassistant", featured: true },
  { id: "spotify", label: "Spotify", description: "Control playback and browse music", category: "life", oauthProvider: "spotify", oauthMethod: "composio" },
  { id: "apple-health", label: "Apple Health", description: "Access health and fitness data", category: "life", comingSoon: true },
  { id: "fitbit", label: "Fitbit", description: "Track fitness and sleep data", category: "life", comingSoon: true },
  { id: "weather", label: "Weather", description: "Current and forecast weather data", category: "life", comingSoon: true },

  // --- Built-in Tools (always active) ---
  { id: "filesystem", label: "Filesystem", description: "Read, write, and search local files", category: "builtin" },
  { id: "http-fetch", label: "HTTP Fetch", description: "Call any REST API or fetch web pages", category: "builtin" },
  { id: "web-search", label: "Web Search", description: "Search the web for current information", category: "builtin" },
  { id: "memory", label: "Memory", description: "Persistent long-term memory across chats", category: "builtin" },
  { id: "time", label: "Date & Time", description: "Timezone-aware date/time awareness", category: "builtin" },
  { id: "browser", label: "Browser", description: "Browse websites and interact with web pages", category: "builtin" },
];

export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Portuguese",
  "Italian", "Dutch", "Russian", "Japanese", "Chinese",
  "Korean", "Arabic", "Hindi", "Turkish", "Polish",
];
