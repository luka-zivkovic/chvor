import type {
  LLMProviderDef,
  EmbeddingProviderDef,
  IntegrationProviderDef,
  ImageGenProviderDef,
  OAuthProviderDef,
} from "@chvor/shared";

// ── LLM Providers ────────────────────────────────────────────────

export const LLM_PROVIDERS: LLMProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "anthropic",
    credentialType: "anthropic",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "sk-ant-...",
        helpUrl: "https://console.anthropic.com/settings/keys",
      },
    ],
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200000, supportsStreaming: true, maxTokens: 16384, cost: { input: 3, output: 15 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextWindow: 200000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.8, output: 4 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200000, supportsStreaming: true, maxTokens: 16384, cost: { input: 15, output: 75 }, capabilities: ["vision", "toolUse", "code", "reasoning"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "openai",
    credentialType: "openai",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "sk-...",
        helpUrl: "https://platform.openai.com/api-keys",
      },
    ],
    models: [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, supportsStreaming: true, maxTokens: 16384, cost: { input: 2.5, output: 10 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000, supportsStreaming: true, maxTokens: 16384, cost: { input: 0.15, output: 0.6 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "o3-mini", name: "o3-mini", contextWindow: 200000, supportsStreaming: true, maxTokens: 100000, cost: { input: 1.1, output: 4.4 }, capabilities: ["reasoning", "toolUse", "code"] },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    icon: "deepseek",
    credentialType: "deepseek",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "sk-...",
        helpUrl: "https://platform.deepseek.com/api_keys",
      },
    ],
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.27, output: 1.1 }, capabilities: ["toolUse", "code"] },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.55, output: 2.19 }, capabilities: ["reasoning", "code"] },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    icon: "minimax",
    credentialType: "minimax",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "eyJ...",
        helpUrl: "https://platform.minimax.io/platform-api/api-keys",
      },
    ],
    models: [
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextWindow: 200000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.3, output: 1.2 }, capabilities: ["reasoning", "toolUse", "code"] },
      { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", contextWindow: 200000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.3, output: 1.2 }, capabilities: ["reasoning", "toolUse", "code"] },
      { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextWindow: 200000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.3, output: 1.2 }, capabilities: ["reasoning", "toolUse", "code"] },
      { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 Highspeed", contextWindow: 200000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.3, output: 1.2 }, capabilities: ["reasoning", "toolUse", "code"] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "openrouter",
    credentialType: "openrouter",
    freeTextModel: true,
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "sk-or-v1-...",
        helpUrl: "https://openrouter.ai/keys",
      },
    ],
    models: [],
  },
  {
    id: "google",
    name: "Google Gemini",
    icon: "google",
    credentialType: "google-ai",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "AIza...",
        helpUrl: "https://aistudio.google.com/app/apikey",
      },
    ],
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1000000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.1, output: 0.4 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextWindow: 2000000, supportsStreaming: true, maxTokens: 8192, cost: { input: 1.25, output: 5 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite", contextWindow: 1000000, supportsStreaming: true, maxTokens: 8192, cost: { input: 0.075, output: 0.3 }, capabilities: ["vision", "code"] },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    icon: "groq",
    credentialType: "groq",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "gsk_...",
        helpUrl: "https://console.groq.com/keys",
      },
    ],
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", contextWindow: 128000, supportsStreaming: true, maxTokens: 32768, capabilities: ["toolUse", "code"] },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", contextWindow: 128000, supportsStreaming: true, maxTokens: 8192, capabilities: ["code"] },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", contextWindow: 32768, supportsStreaming: true, maxTokens: 32768, capabilities: ["code"] },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    icon: "mistral",
    credentialType: "mistral",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "...",
        helpUrl: "https://console.mistral.ai/api-keys",
      },
    ],
    models: [
      { id: "mistral-large-latest", name: "Mistral Large", contextWindow: 128000, supportsStreaming: true, maxTokens: 32768, cost: { input: 2, output: 6 }, capabilities: ["vision", "toolUse", "code"] },
      { id: "mistral-small-latest", name: "Mistral Small", contextWindow: 128000, supportsStreaming: true, maxTokens: 32768, cost: { input: 0.2, output: 0.6 }, capabilities: ["toolUse", "code"] },
      { id: "codestral-latest", name: "Codestral", contextWindow: 256000, supportsStreaming: true, maxTokens: 32768, cost: { input: 0.3, output: 0.9 }, capabilities: ["code"] },
    ],
  },
  {
    id: "custom-llm",
    name: "Custom LLM",
    icon: "custom-llm",
    credentialType: "custom-llm",
    freeTextModel: true,
    requiredFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        placeholder: "https://my-llm.example.com/v1",
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "sk-...",
        optional: true,
      },
    ],
    models: [],
  },
  {
    id: "ollama",
    name: "Ollama",
    icon: "ollama",
    credentialType: "ollama",
    isLocal: true,
    freeTextModel: true,
    requiredFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        placeholder: "http://localhost:11434/v1",
        defaultValue: "http://localhost:11434/v1",
      },
    ],
    models: [],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    icon: "lmstudio",
    credentialType: "lmstudio",
    isLocal: true,
    freeTextModel: true,
    requiredFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        placeholder: "http://localhost:1234/v1",
        defaultValue: "http://localhost:1234/v1",
      },
    ],
    models: [],
  },
  {
    id: "vllm",
    name: "vLLM",
    icon: "vllm",
    credentialType: "vllm",
    isLocal: true,
    freeTextModel: true,
    requiredFields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        placeholder: "http://localhost:8000/v1",
        defaultValue: "http://localhost:8000/v1",
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "optional",
        optional: true,
      },
    ],
    models: [],
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    icon: "ollama",
    credentialType: "ollama-cloud",
    freeTextModel: true,
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "...",
        helpUrl: "https://ollama.com/settings/keys",
      },
    ],
    models: [],
  },
];

// ── Default lightweight model per provider ───────────────────────

export const DEFAULT_LIGHTWEIGHT: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  minimax: "MiniMax-M2.5-highspeed",
  google: "gemini-2.0-flash-lite",
  groq: "llama-3.1-8b-instant",
  mistral: "mistral-small-latest",
};

// ── Context windows (derived from LLM_PROVIDERS) ────────────────

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = Object.fromEntries(
  LLM_PROVIDERS.flatMap((p) => p.models.map((m) => [m.id, m.contextWindow]))
);

export const DEFAULT_CONTEXT_WINDOW = 128_000;

// ── Max output tokens (derived from LLM_PROVIDERS) ──────────────

export const MODEL_MAX_TOKENS: Record<string, number> = Object.fromEntries(
  LLM_PROVIDERS.flatMap((p) => p.models.filter((m) => m.maxTokens).map((m) => [m.id, m.maxTokens!]))
);

export const DEFAULT_MAX_TOKENS = 4_096;

// ── Embedding Providers ──────────────────────────────────────────

export const EMBEDDING_PROVIDERS: EmbeddingProviderDef[] = [
  {
    id: "local",
    name: "Local (Free)",
    icon: "local",
    credentialType: null,
    isLocal: true,
    models: [
      { id: "Xenova/all-MiniLM-L6-v2", name: "all-MiniLM-L6-v2", dimensions: 384 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "openai",
    credentialType: "openai",
    models: [
      { id: "text-embedding-3-small", name: "Embedding 3 Small", dimensions: 1536 },
      { id: "text-embedding-3-large", name: "Embedding 3 Large", dimensions: 3072 },
    ],
  },
  {
    id: "voyageai",
    name: "Voyage AI",
    icon: "voyageai",
    credentialType: "voyageai",
    models: [
      { id: "voyage-3", name: "Voyage 3", dimensions: 1024 },
      { id: "voyage-3-lite", name: "Voyage 3 Lite", dimensions: 512 },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    icon: "cohere",
    credentialType: "cohere",
    models: [
      { id: "embed-english-v3.0", name: "Embed English v3", dimensions: 1024 },
      { id: "embed-multilingual-v3.0", name: "Embed Multilingual v3", dimensions: 1024 },
    ],
  },
  {
    id: "google",
    name: "Google",
    icon: "google",
    credentialType: "google-ai",
    models: [
      { id: "text-embedding-004", name: "Text Embedding 004", dimensions: 768 },
    ],
  },
];

// ── Integration Providers ────────────────────────────────────────

export const INTEGRATION_PROVIDERS: IntegrationProviderDef[] = [
  {
    id: "telegram",
    name: "Telegram Bot",
    icon: "telegram",
    credentialType: "telegram",
    description: "Connect a Telegram bot to chat with your AI",
    usageContext: "Telegram Bot API: https://api.telegram.org/bot<botToken>/METHOD",
    requiredFields: [
      {
        key: "botToken",
        label: "Bot Token",
        type: "password",
        placeholder: "123456:ABC-DEF...",
        helpUrl: "https://t.me/BotFather",
      },
    ],
  },
  {
    id: "discord",
    name: "Discord Bot",
    icon: "discord",
    credentialType: "discord",
    description: "Connect a Discord bot to chat with your AI",
    usageContext: "Authorization: Bot <botToken>. API base: https://discord.com/api/v10/",
    requiredFields: [
      {
        key: "botToken",
        label: "Bot Token",
        type: "password",
        placeholder: "MTIzNDU2Nzg5MDEy...",
        helpUrl: "https://discord.com/developers/applications",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack App",
    icon: "slack",
    credentialType: "slack",
    description: "Connect a Slack app via Socket Mode",
    usageContext: "Authorization: Bearer <botToken>. API base: https://slack.com/api/",
    requiredFields: [
      {
        key: "botToken",
        label: "Bot Token (xoxb-)",
        type: "password",
        placeholder: "xoxb-...",
        helpUrl: "https://api.slack.com/apps",
        helpText: "Slack requires both a Bot Token AND an App-Level Token. Create a Slack app at api.slack.com/apps, enable Socket Mode, and add the chat:write + app_mentions:read scopes.",
      },
      {
        key: "appToken",
        label: "App-Level Token (xapp-)",
        type: "password",
        placeholder: "xapp-...",
        helpUrl: "https://api.slack.com/apps",
      },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    icon: "elevenlabs",
    credentialType: "elevenlabs",
    description: "Text-to-speech and voice cloning",
    usageContext: "xi-api-key: <apiKey>. API base: https://api.elevenlabs.io/v1/",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "xi_...",
        helpUrl: "https://elevenlabs.io/app/settings/api-keys",
      },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "github",
    credentialType: "github",
    description: "Repos, issues, PRs, and code search",
    usageContext: "Authorization: token <apiKey>. API base: https://api.github.com. Accept: application/vnd.github.v3+json",
    requiredFields: [
      {
        key: "apiKey",
        label: "Personal Access Token",
        type: "password",
        placeholder: "ghp_...",
        helpUrl: "https://github.com/settings/tokens",
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    icon: "notion",
    credentialType: "notion",
    description: "Query and update Notion pages and databases",
    usageContext: "Authorization: Bearer <apiKey>. Notion-Version: 2022-06-28. API base: https://api.notion.com/v1/",
    requiredFields: [
      {
        key: "apiKey",
        label: "Integration Token",
        type: "password",
        placeholder: "ntn_...",
        helpUrl: "https://www.notion.so/my-integrations",
      },
    ],
  },
  {
    id: "smtp",
    name: "SMTP / Email",
    icon: "smtp",
    credentialType: "smtp",
    description: "Send emails via SMTP or email API (SendGrid, Resend)",
    usageContext: "Use host, port, username, password to configure SMTP transport. Not an HTTP API.",
    requiredFields: [
      { key: "host", label: "SMTP Host", type: "text", placeholder: "smtp.gmail.com", optional: true },
      { key: "port", label: "SMTP Port", type: "text", placeholder: "587", optional: true },
      { key: "username", label: "Username", type: "text", placeholder: "user@example.com", optional: true },
      { key: "password", label: "Password", type: "password", placeholder: "••••", optional: true },
      { key: "apiKey", label: "API Key (SendGrid/Resend)", type: "password", placeholder: "re_... or SG...", optional: true },
    ],
  },
  {
    id: "api-key",
    name: "Generic API Key",
    icon: "api-key",
    credentialType: "api-key",
    description: "Store any API key for tools and integrations",
    usageContext: "Generic key. Check the service docs for the correct header (usually Authorization: Bearer <apiKey>).",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "Enter API key",
      },
    ],
  },
  // --- Additional integrations ---
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: "whatsapp",
    credentialType: "whatsapp",
    description: "Connect WhatsApp via QR code pairing (Baileys)",
    requiredFields: [],
  },
  {
    id: "matrix",
    name: "Matrix",
    icon: "matrix",
    credentialType: "matrix",
    description: "Connect via Matrix/Element",
    requiredFields: [
      {
        key: "homeserverUrl",
        label: "Homeserver URL",
        type: "text",
        placeholder: "https://matrix.org",
      },
      {
        key: "accessToken",
        label: "Access Token",
        type: "password",
        placeholder: "syt_...",
      },
      {
        key: "userId",
        label: "User ID",
        type: "text",
        placeholder: "@bot:matrix.org",
      },
    ],
  },
  {
    id: "obsidian",
    name: "Obsidian",
    icon: "obsidian",
    credentialType: "obsidian",
    description: "Read and write notes in your Obsidian vault",
    requiredFields: [
      {
        key: "vaultPath",
        label: "Vault Path",
        type: "text",
        placeholder: "/home/user/my-vault",
      },
    ],
  },
  {
    id: "gitlab",
    name: "GitLab",
    icon: "gitlab",
    credentialType: "gitlab",
    description: "Projects, issues, MRs, and code search",
    requiredFields: [
      {
        key: "instanceUrl",
        label: "Instance URL",
        type: "text",
        placeholder: "https://gitlab.com",
      },
      {
        key: "token",
        label: "Personal Access Token",
        type: "password",
        placeholder: "glpat-...",
        helpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
      },
    ],
  },
  {
    id: "jira",
    name: "Jira",
    icon: "jira",
    credentialType: "jira",
    description: "Search, create, and manage Jira issues",
    requiredFields: [
      {
        key: "domain",
        label: "Atlassian Domain",
        type: "text",
        placeholder: "your-company.atlassian.net",
      },
      {
        key: "email",
        label: "Email",
        type: "text",
        placeholder: "you@company.com",
      },
      {
        key: "apiToken",
        label: "API Token",
        type: "password",
        helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
      },
    ],
  },
  {
    id: "homeassistant",
    name: "Home Assistant",
    icon: "homeassistant",
    credentialType: "homeassistant",
    description: "Control smart home devices and automations",
    requiredFields: [
      {
        key: "instanceUrl",
        label: "Instance URL",
        type: "text",
        placeholder: "http://homeassistant.local:8123",
      },
      {
        key: "token",
        label: "Long-Lived Access Token",
        type: "password",
        helpUrl: "https://www.home-assistant.io/docs/authentication/",
      },
    ],
  },
  {
    id: "google-oauth",
    name: "Google OAuth App",
    icon: "google",
    credentialType: "google-oauth",
    description: "Your Google Cloud OAuth credentials for direct Gmail, Calendar, and Drive access",
    requiredFields: [
      {
        key: "clientId",
        label: "Client ID",
        type: "text",
        placeholder: "123456789-abc.apps.googleusercontent.com",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        helpText: "Create an OAuth 2.0 Client ID in Google Cloud Console. Set the redirect URI to http://localhost:9147/api/oauth/callback",
      },
      {
        key: "clientSecret",
        label: "Client Secret",
        type: "password",
        placeholder: "GOCSPX-...",
      },
    ],
  },
  {
    id: "reddit-oauth",
    name: "Reddit OAuth App",
    icon: "reddit",
    credentialType: "reddit-oauth",
    description: "Your Reddit app credentials for direct Reddit access",
    requiredFields: [
      {
        key: "clientId",
        label: "Client ID",
        type: "text",
        placeholder: "Your Reddit app client ID",
        helpUrl: "https://www.reddit.com/prefs/apps",
        helpText: "Create a 'web app' at reddit.com/prefs/apps. Set the redirect URI to http://localhost:9147/api/oauth/callback",
      },
      {
        key: "clientSecret",
        label: "Client Secret",
        type: "password",
        placeholder: "Your Reddit app secret",
        optional: true,
      },
    ],
  },
  {
    id: "composio",
    name: "Composio",
    icon: "share-2",
    credentialType: "composio",
    description: "Connect social accounts (Twitter, Reddit, LinkedIn) and 500+ apps via OAuth",
    usageContext: "x-api-key: <apiKey>. API base: https://backend.composio.dev/api/v3/",
    requiredFields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "sk-...",
        helpUrl: "https://app.composio.dev/settings",
      },
    ],
  },
];

// ── Image Generation Providers ───────────────────────────────────

export const IMAGE_GEN_PROVIDERS: ImageGenProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    credentialType: "openai",
    models: [
      { id: "gpt-image-1", name: "GPT Image 1" },
      { id: "dall-e-3", name: "DALL-E 3" },
      { id: "dall-e-2", name: "DALL-E 2" },
    ],
  },
  {
    id: "replicate",
    name: "Replicate",
    credentialType: "replicate",
    models: [
      { id: "black-forest-labs/flux-1.1-pro-ultra", name: "Flux 1.1 Pro Ultra" },
      { id: "black-forest-labs/flux-schnell", name: "Flux Schnell" },
    ],
  },
  {
    id: "fal",
    name: "Fal.ai",
    credentialType: "fal",
    models: [
      { id: "fal-ai/flux/dev", name: "Flux Dev" },
      { id: "fal-ai/flux-pro/v1.1-ultra", name: "Flux Pro 1.1 Ultra" },
    ],
  },
];

// ── OAuth Providers ─────────────────────────────────────────────

export const OAUTH_PROVIDERS: OAuthProviderDef[] = [
  // --- Direct OAuth (Tier 2) — no third-party dependency ---
  {
    id: "google",
    name: "Google (Gmail, Calendar, Drive)",
    icon: "google",
    method: "direct",
    category: "productivity",
    description: "Connect your Google account directly for Gmail, Calendar, and Drive access.",
    setupCredentialType: "google-oauth",
  },
  {
    id: "reddit",
    name: "Reddit",
    icon: "reddit",
    method: "direct",
    category: "social",
    description: "Connect your Reddit account directly for browsing, posting, and messaging.",
    setupCredentialType: "reddit-oauth",
  },

  // --- Composio OAuth (Tier 3) — requires Composio API key ---
  {
    id: "twitter",
    name: "Twitter / X",
    icon: "twitter",
    method: "composio",
    composioToolkit: "twitter",
    category: "social",
    description: "Post tweets, read timeline, and manage your Twitter account.",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    icon: "linkedin",
    method: "composio",
    composioToolkit: "linkedin",
    category: "social",
    description: "Post updates, read feed, and manage your LinkedIn profile.",
  },
  {
    id: "spotify",
    name: "Spotify",
    icon: "spotify",
    method: "composio",
    composioToolkit: "spotify",
    category: "life",
    description: "Control playback, browse music, and manage playlists.",
  },
  {
    id: "instagram",
    name: "Instagram",
    icon: "instagram",
    method: "composio",
    composioToolkit: "instagram",
    category: "social",
    description: "Post photos, browse feed, and manage your Instagram account.",
  },
  {
    id: "youtube",
    name: "YouTube",
    icon: "youtube",
    method: "composio",
    composioToolkit: "youtube",
    category: "social",
    description: "Search videos, manage playlists, and interact with YouTube.",
  },
  {
    id: "tiktok",
    name: "TikTok",
    icon: "tiktok",
    method: "composio",
    composioToolkit: "tiktok",
    category: "social",
    description: "Post videos and interact with your TikTok account.",
  },
  {
    id: "bluesky",
    name: "Bluesky",
    icon: "bluesky",
    method: "composio",
    composioToolkit: "bluesky",
    category: "social",
    description: "Post, follow, and interact on Bluesky.",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    icon: "pinterest",
    method: "composio",
    composioToolkit: "pinterest",
    category: "social",
    description: "Pin, board, and browse Pinterest.",
  },
];

// ── Derived sets ─────────────────────────────────────────────────

/** All credential types that belong to LLM or embedding providers (not integrations/channels). */
export const LLM_CRED_TYPES: ReadonlySet<string> = new Set([
  ...LLM_PROVIDERS.map((p) => p.credentialType),
  ...EMBEDDING_PROVIDERS.filter((p) => p.credentialType).map((p) => p.credentialType!),
  "custom-llm",
]);

/** Credential types that map to channel adapters. */
export const CHANNEL_CRED_TYPES: ReadonlySet<string> = new Set(["telegram", "discord", "slack"]);

// ── Helpers ──────────────────────────────────────────────────────

export function getLLMProvider(id: string): LLMProviderDef | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

export function getEmbeddingProvider(id: string): EmbeddingProviderDef | undefined {
  return EMBEDDING_PROVIDERS.find((p) => p.id === id);
}
