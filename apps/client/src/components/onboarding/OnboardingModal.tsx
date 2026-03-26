import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { usePersonaStore } from "../../stores/persona-store";
import { useCredentialStore } from "../../stores/credential-store";
import { useAuthStore } from "../../stores/auth-store";
import { AddCredentialDialog } from "../credentials/AddCredentialDialog";
import { VoiceSettingsContent } from "../panels/VoiceSettingsContent";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { LLMProviderDef, CredentialType } from "@chvor/shared";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import {
  PERSONALITY_PRESETS as PRESETS,
  TAG_CONFIG,
  type PersonalityTag,
} from "@/lib/personality-presets";

interface Props {
  onComplete: () => void;
}

const LANGUAGES = [
  "English", "Spanish", "French", "German", "Portuguese",
  "Italian", "Dutch", "Russian", "Japanese", "Chinese",
  "Korean", "Arabic", "Hindi", "Turkish", "Polish",
];

const ALL_TAGS: PersonalityTag[] = ["fun", "productivity", "balanced"];

/** Skill catalog for onboarding Step 6. */
interface SkillEntry {
  id: string;
  label: string;
  description: string;
  category: "communication" | "knowledge" | "devtools" | "productivity" | "life" | "builtin";
  /** Icon key for ProviderIcon. Falls back to id if omitted. */
  icon?: string;
  /** Credential type needed — if undefined, skill is always active (bundled). */
  credType?: CredentialType;
  /** True = not yet available, shown as "Coming soon". */
  comingSoon?: boolean;
  /** Show in the featured / popular row at the top. */
  featured?: boolean;
}

const CATEGORY_LABELS: Record<SkillEntry["category"], string> = {
  communication: "Communication",
  knowledge: "Knowledge & Docs",
  devtools: "Developer Tools",
  productivity: "Productivity",
  life: "Smart Home & Life",
  builtin: "Built-in",
};

const CATEGORY_ORDER: SkillEntry["category"][] = [
  "communication", "knowledge", "devtools", "productivity", "life", "builtin",
];

const SKILL_CATALOG: SkillEntry[] = [
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
  { id: "gmail", label: "Gmail", description: "Read, search, and send emails", category: "productivity", comingSoon: true },
  { id: "google-calendar", label: "Google Calendar", description: "View, create, and manage events", category: "productivity", comingSoon: true },
  { id: "google-drive", label: "Google Drive", description: "Search, read, and organize files", category: "productivity", comingSoon: true },
  { id: "linear", label: "Linear", description: "Create and manage issues and projects", category: "productivity", comingSoon: true },
  { id: "todoist", label: "Todoist", description: "Manage tasks and to-do lists", category: "productivity", comingSoon: true },
  { id: "dropbox", label: "Dropbox", description: "Access and manage cloud files", category: "productivity", comingSoon: true },
  { id: "onedrive", label: "OneDrive", description: "Access Microsoft cloud storage", category: "productivity", comingSoon: true },

  // --- Smart Home & Life ---
  { id: "homeassistant", label: "Home Assistant", description: "Control smart home devices and automations", category: "life", credType: "homeassistant", featured: true },
  { id: "spotify", label: "Spotify", description: "Control playback and browse music", category: "life", comingSoon: true },
  { id: "apple-health", label: "Apple Health", description: "Access health and fitness data", category: "life", comingSoon: true },
  { id: "fitbit", label: "Fitbit", description: "Track fitness and sleep data", category: "life", comingSoon: true },
  { id: "weather", label: "Weather", description: "Current and forecast weather data", category: "life", comingSoon: true },

  // --- Built-in Tools (always active) ---
  { id: "filesystem", label: "Filesystem", description: "Read, write, and search local files", category: "builtin" },
  { id: "http-fetch", label: "HTTP Fetch", description: "Call any REST API or fetch web pages", category: "builtin" },
  { id: "web-search", label: "Web Search", description: "Search the web via DuckDuckGo", category: "builtin" },
  { id: "memory", label: "Memory", description: "Persistent long-term memory across chats", category: "builtin" },
  { id: "time", label: "Date & Time", description: "Timezone-aware date/time awareness", category: "builtin" },
  { id: "browser", label: "Browser", description: "Browse websites and interact with web pages", category: "builtin" },
];

const TOTAL_STEPS = 8;

export function OnboardingModal({ onComplete }: Props) {
  const { updatePersona } = usePersonaStore();
  const { credentials, providers, llmProviders, embeddingProviders, fetchAll: fetchCredentials } =
    useCredentialStore();

  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [language, setLanguage] = useState("English");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<PersonalityTag | null>(null);
  const [customProfile, setCustomProfile] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [fineTuneTab, setFineTuneTab] = useState<"directives" | "voice">("voice");
  const [aiName, setAiName] = useState("Chvor");
  const [userNickname, setUserNickname] = useState("");
  const [directives, setDirectives] = useState("");
  const [showCredDialog, setShowCredDialog] = useState(false);
  const [selectedLLMSetup, setSelectedLLMSetup] = useState<LLMProviderDef | null>(null);
  const [llmSetupFields, setLlmSetupFields] = useState<Record<string, string>>({});
  const [llmSetupError, setLlmSetupError] = useState<string | null>(null);
  const [llmSetupSaving, setLlmSetupSaving] = useState(false);
  const [setupCredType, setSetupCredType] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");

  // Security step state
  const { checkStatus: refreshAuth } = useAuthStore();
  const [wantAuth, setWantAuth] = useState<boolean | null>(null);
  const [authMethod, setAuthMethod] = useState<"password" | "pin">("password");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authPin, setAuthPin] = useState("");
  const [onboardRecoveryKey, setOnboardRecoveryKey] = useState("");
  const [authSetupError, setAuthSetupError] = useState("");

  const timezones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
      return [
        "UTC", "America/New_York", "America/Chicago", "America/Denver",
        "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Europe/Paris",
        "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney",
      ];
    }
  }, []);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const hasLLM = credentials.some((c) =>
    providers.some((p) => p.credentialType === c.type && "models" in p)
  );

  // Find the active LLM provider (first credential matching an LLM provider)
  const activeLLMProvider = useMemo(() => {
    for (const c of credentials) {
      const p = providers.find((p) => p.credentialType === c.type && "models" in p);
      if (p) return p as LLMProviderDef;
    }
    return null;
  }, [credentials, providers]);

  // Auto-select first model when provider becomes available
  useEffect(() => {
    if (activeLLMProvider && !selectedModel) {
      setSelectedModel(activeLLMProvider.models[0]?.id ?? "");
    }
  }, [activeLLMProvider, selectedModel]);

  const credTypeSet = new Set(credentials.map((c) => c.type));

  /** Check if a skill from the catalog is connected/active. */
  const isSkillActive = (skill: SkillEntry): boolean => {
    if (skill.comingSoon) return false;
    if (!skill.credType) return true; // bundled, always active
    return credTypeSet.has(skill.credType);
  };

  const configurableSkills = SKILL_CATALOG.filter((s) => !s.comingSoon);
  const activeSkillCount = configurableSkills.filter(isSkillActive).length;

  const selectedPresetObj = PRESETS.find((p) => p.id === selectedPreset);
  const resolvedProfile = showCustom
    ? customProfile
    : selectedPresetObj?.profile ?? "";

  /** Build a preview of the system prompt for the user to see. */
  const buildPreview = (): string => {
    const who = aiName || "Chvor";
    const addr = userNickname || name || "you";
    const profile = resolvedProfile || "(no personality selected)";
    const parts: string[] = [profile];
    if (selectedPresetObj && !showCustom) {
      if (selectedPresetObj.tone) parts.push(`**Tone:** ${selectedPresetObj.tone}`);
      if (selectedPresetObj.communicationStyle)
        parts.push(`**Communication style:** ${selectedPresetObj.communicationStyle}`);
      if (selectedPresetObj.boundaries) parts.push(`**Boundaries:** ${selectedPresetObj.boundaries}`);
      if (selectedPresetObj.exampleResponses?.length) {
        const exLines = selectedPresetObj.exampleResponses
          .map((ex, i) => `**Example ${i + 1}:**\nUser: ${ex.user}\nAssistant: ${ex.assistant}`)
          .join("\n\n");
        parts.push(exLines);
      }
    }
    return `You are ${who}, a personal AI assistant.\n\n## Personality & Style\n${parts.join("\n\n")}\n\n## User\nAddress the user as "${addr}".${language !== "English" ? `\nRespond in ${language}.` : ""}`;
  };

  const handleFinish = async (): Promise<void> => {
    try {
      await updatePersona({
        profile: resolvedProfile,
        directives,
        onboarded: true,
        name: name.trim() || undefined,
        timezone,
        language,
        aiName: aiName.trim() || undefined,
        userNickname: userNickname.trim() || undefined,
        // Structured persona fields from selected preset
        tone: selectedPresetObj?.tone ?? undefined,
        boundaries: selectedPresetObj?.boundaries ?? undefined,
        communicationStyle: selectedPresetObj?.communicationStyle ?? undefined,
        exampleResponses: selectedPresetObj?.exampleResponses ?? undefined,
      });
      onComplete();
    } catch {
      toast.error("Failed to save — please try again");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 backdrop-blur-md">
      <div className="animate-scale-in glass-strong w-full max-w-lg rounded-2xl border border-border/50 p-6 shadow-2xl">
        {/* Step indicator */}
        <div className="mb-5 flex items-center gap-3">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
            <div key={s} className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                  s <= step
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {s < step ? "\u2713" : s}
              </span>
              {s < TOTAL_STEPS && (
                <div
                  className={`h-px w-4 ${
                    s < step ? "bg-primary/50" : "bg-border"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Welcome */}
        {step === 1 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Hey there. Let's set things up.
            </h2>
            <p className="mb-5 text-xs text-muted-foreground">
              Just a few quick things so Chvor feels like yours.
            </p>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                  What should I call you?
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="bg-input"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                  Your timezone
                </label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"
                >
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                  Preferred language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {lang}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <Button size="sm" onClick={() => setStep(2)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Connect a brain */}
        {step === 2 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Connect a brain
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Chvor needs an LLM provider to work. This step is required.
            </p>

            {hasLLM && activeLLMProvider ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/8 px-4 py-3">
                  <span className="text-green-400">{"\u2713"}</span>
                  <ProviderIcon icon={activeLLMProvider.icon} size={18} className="text-foreground" />
                  <span className="text-sm text-foreground">
                    {activeLLMProvider.name} connected
                  </span>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                    Choose a model
                  </label>
                  {activeLLMProvider.freeTextModel ? (
                    <Input
                      type="text"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      placeholder={activeLLMProvider.id === "ollama" || activeLLMProvider.id === "ollama-cloud"
                        ? "e.g. llama3.2, qwen2.5:14b"
                        : "e.g. meta-llama/llama-3.1-70b"}
                      className="w-full bg-input font-mono"
                    />
                  ) : (
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"
                    >
                      {activeLLMProvider.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({Math.round(m.contextWindow / 1000)}k context)
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ) : providers.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Loading providers...
              </p>
            ) : !selectedLLMSetup ? (
              <div className="grid grid-cols-2 gap-2">
                {llmProviders.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedLLMSetup(p);
                      const defaults: Record<string, string> = {};
                      for (const f of p.requiredFields) {
                        if (f.defaultValue) defaults[f.key] = f.defaultValue;
                      }
                      setLlmSetupFields(defaults);
                      setLlmSetupError(null);
                    }}
                    className="flex items-center gap-2.5 rounded-lg border border-border/50 p-3 text-left text-xs transition-colors hover:border-primary/30 hover:bg-muted"
                  >
                    <ProviderIcon icon={p.icon} size={20} className="shrink-0 text-foreground/80" />
                    <div>
                      <p className="font-medium text-foreground">{p.name}</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {p.models.length > 0
                          ? `${p.models.length} model${p.models.length !== 1 ? "s" : ""}`
                          : p.freeTextModel
                            ? "Any model"
                            : ""}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setSelectedLLMSetup(null);
                      setLlmSetupFields({});
                      setLlmSetupError(null);
                    }}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    &larr;
                  </button>
                  <ProviderIcon icon={selectedLLMSetup.icon} size={16} className="text-foreground/70" />
                  <span className="text-xs font-medium text-foreground">
                    {selectedLLMSetup.name}
                  </span>
                </div>

                {selectedLLMSetup.requiredFields.map((field) => (
                  <div key={field.key} className="flex flex-col gap-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {field.label}
                      {field.helpUrl && (
                        <a
                          href={field.helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-1 text-primary normal-case underline"
                        >
                          Get key
                        </a>
                      )}
                    </label>
                    <Input
                      type={field.type === "password" ? "password" : "text"}
                      value={llmSetupFields[field.key] ?? ""}
                      onChange={(e) => {
                        setLlmSetupFields((prev) => ({ ...prev, [field.key]: e.target.value }));
                        setLlmSetupError(null);
                      }}
                      placeholder={field.placeholder}
                      className="bg-input font-mono"
                    />
                  </div>
                ))}

                {llmSetupError && (
                  <p className="text-[10px] text-red-400">{llmSetupError}</p>
                )}

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelectedLLMSetup(null);
                      setLlmSetupFields({});
                      setLlmSetupError(null);
                    }}
                    className="text-[10px]"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      !selectedLLMSetup.requiredFields.every(
                        (f) => llmSetupFields[f.key]?.trim()
                      ) || llmSetupSaving
                    }
                    onClick={async () => {
                      setLlmSetupSaving(true);
                      setLlmSetupError(null);
                      try {
                        const testResult = await api.credentials.test({
                          type: selectedLLMSetup.credentialType,
                          data: llmSetupFields,
                        });
                        if (!testResult.success) {
                          const hint = selectedLLMSetup.isLocal
                            ? " Is Ollama running? Start it with `ollama serve`."
                            : "";
                          setLlmSetupError((testResult.error ?? "Connection failed") + hint);
                          return;
                        }
                        await api.credentials.create({
                          name: selectedLLMSetup.name,
                          type: selectedLLMSetup.credentialType,
                          data: llmSetupFields,
                        });
                        await fetchCredentials();
                        setSelectedLLMSetup(null);
                        setLlmSetupFields({});
                      } catch (err) {
                        setLlmSetupError(
                          err instanceof Error ? err.message : String(err)
                        );
                      } finally {
                        setLlmSetupSaving(false);
                      }
                    }}
                    className="text-[10px]"
                  >
                    {llmSetupSaving ? "Saving..." : "Connect"}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    if (activeLLMProvider && selectedModel) {
                      await api.llmConfig.set({ providerId: activeLLMProvider.id, model: selectedModel });
                    }
                    setStep(3);
                  } catch {
                    toast.error("Failed to save model configuration");
                  }
                }}
                disabled={!hasLLM}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Pick a vibe */}
        {step === 3 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Pick a vibe
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              How should your AI talk to you? You can always change this later.
            </p>

            {!showCustom ? (
              <div className="space-y-2">
                {/* Tag filter pills */}
                <div className="mb-3 flex gap-1.5">
                  <button
                    onClick={() => setTagFilter(null)}
                    className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-all ${
                      tagFilter === null
                        ? "border-foreground/30 bg-foreground/10 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    All
                  </button>
                  {ALL_TAGS.map((t) => (
                    <button
                      key={t}
                      onClick={() => setTagFilter(tagFilter === t ? null : t)}
                      className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-all ${
                        tagFilter === t
                          ? TAG_CONFIG[t].className
                          : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {TAG_CONFIG[t].label}
                    </button>
                  ))}
                </div>
                {PRESETS.filter((p) => !tagFilter || p.tag === tagFilter).map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => setSelectedPreset(preset.id)}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition-all ${
                      selectedPreset === preset.id
                        ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                        : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {preset.label}
                      </span>
                      <span
                        className={`rounded-full border px-1.5 py-px text-[9px] font-medium ${TAG_CONFIG[preset.tag].className}`}
                      >
                        {TAG_CONFIG[preset.tag].label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {preset.tagline}
                    </p>
                  </button>
                ))}

                <button
                  onClick={() => {
                    setShowCustom(true);
                    setSelectedPreset(null);
                  }}
                  className="w-full rounded-lg border border-dashed border-border px-4 py-3 text-left text-xs text-muted-foreground hover:border-primary/30 hover:text-foreground"
                >
                  Write my own...
                </button>
              </div>
            ) : (
              <div>
                <Textarea
                  value={customProfile}
                  onChange={(e) => setCustomProfile(e.target.value)}
                  rows={5}
                  className="bg-input"
                  autoFocus
                  placeholder="Describe how you want your AI to communicate..."
                />
                <p className="mt-2 text-[10px] text-muted-foreground/60">
                  You can fine-tune tone, boundaries, and example responses in Settings after onboarding.
                </p>
                <button
                  onClick={() => setShowCustom(false)}
                  className="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Back to presets
                </button>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                size="sm"
                onClick={() => setStep(4)}
                disabled={!selectedPreset && !customProfile.trim()}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Make it yours */}
        {step === 4 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Make it yours
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Give your AI a name and tell it how to address you.
            </p>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                  Name your AI
                </label>
                <Input
                  value={aiName}
                  onChange={(e) => setAiName(e.target.value)}
                  placeholder="Chvor"
                  className="bg-input"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                  How should it address you?
                </label>
                <Input
                  value={userNickname}
                  onChange={(e) => setUserNickname(e.target.value)}
                  placeholder={name || "Boss, Chief, your name..."}
                  className="bg-input"
                />
              </div>

              <div>
                <label className="mb-2 block text-[10px] font-medium text-muted-foreground">
                  System prompt preview
                </label>
                <div className="max-h-36 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {buildPreview()}
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep(3)}
              >
                Back
              </Button>
              <Button size="sm" onClick={() => setStep(5)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 5: Fine-tune (optional) */}
        {step === 5 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Fine-tune
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              Optional — set ground rules or configure voice. You can change these anytime in Settings.
            </p>

            {/* Tab switcher */}
            <div className="mb-4 flex gap-1 rounded-lg bg-muted/30 p-0.5">
              <button
                onClick={() => setFineTuneTab("voice")}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  fineTuneTab === "voice"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Voice
              </button>
              <button
                onClick={() => setFineTuneTab("directives")}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  fineTuneTab === "directives"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Special instructions
              </button>
            </div>

            {fineTuneTab === "voice" ? (
              <div className="max-h-[280px] overflow-y-auto pr-1">
                <VoiceSettingsContent compact />
              </div>
            ) : (
              <div>
                <Textarea
                  value={directives}
                  onChange={(e) => setDirectives(e.target.value)}
                  rows={4}
                  className="bg-input"
                  placeholder={"e.g.,\n- Always respond in bullet points\n- Never suggest paid tools\n- Keep replies under 200 words"}
                />
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep(4)}>
                Back
              </Button>
              <Button size="sm" onClick={() => setStep(6)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {/* Step 6: Skills & Integrations */}
        {step === 6 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Power up
            </h2>
            <p className="mb-4 text-xs text-muted-foreground">
              These skills extend what your AI can do. Some are ready to go, others need a quick setup.
            </p>

            {setupCredType ? (
              <AddCredentialDialog
                initialCredType={setupCredType}
                onClose={() => {
                  setSetupCredType(null);
                  fetchCredentials();
                }}
              />
            ) : (
              <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
                {/* Featured integrations */}
                <div>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Popular
                  </h3>
                  <div className="grid grid-cols-4 gap-2">
                    {SKILL_CATALOG.filter((s) => s.featured).map((skill) => {
                      const active = isSkillActive(skill);
                      return (
                        <button
                          key={`featured-${skill.id}`}
                          onClick={() =>
                            !active && skill.credType && setSetupCredType(skill.credType)
                          }
                          disabled={active}
                          className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center transition-all ${
                            active
                              ? "border-green-500/20 bg-green-500/5"
                              : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                          }`}
                        >
                          <ProviderIcon icon={skill.icon ?? skill.id} size={22} className="text-muted-foreground" />
                          <span className="text-[11px] font-medium text-foreground">{skill.label}</span>
                          {active && (
                            <span className="text-[9px] text-green-400">Active</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {CATEGORY_ORDER.map((cat) => {
                  const skills = configurableSkills.filter((s) => s.category === cat);
                  if (skills.length === 0) return null;
                  return (
                    <div key={cat}>
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        {CATEGORY_LABELS[cat]}
                      </h3>
                      <div className="space-y-1.5">
                        {skills.map((skill) => {
                          const active = isSkillActive(skill);
                          const soon = skill.comingSoon;
                          return (
                            <button
                              key={skill.id}
                              onClick={() =>
                                !active && !soon && skill.credType && setSetupCredType(skill.credType)
                              }
                              disabled={active || soon}
                              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-all ${
                                soon
                                  ? "border-border/50 opacity-50"
                                  : active
                                    ? "border-green-500/20 bg-green-500/5"
                                    : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                <ProviderIcon icon={skill.icon ?? skill.id} size={18} className="shrink-0 text-muted-foreground" />
                                <div>
                                  <span className="text-sm font-medium text-foreground">
                                    {skill.label}
                                  </span>
                                  <p className="text-[11px] text-muted-foreground">
                                    {skill.description}
                                  </p>
                                </div>
                              </div>
                              {soon ? (
                                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[9px] text-muted-foreground">
                                  Soon
                                </span>
                              ) : active ? (
                                <span className="shrink-0 text-[10px] text-green-400">
                                  Active
                                </span>
                              ) : (
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  Set up
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!setupCredType && (
              <div className="mt-4 flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {activeSkillCount}/{configurableSkills.length} active
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStep(5)}
                  >
                    Back
                  </Button>
                  <Button size="sm" onClick={() => setStep(7)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 7: Done */}
        {/* Step 7: Security (optional) */}
        {step === 7 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              Protect your instance?
            </h2>
            <p className="mb-5 text-xs text-muted-foreground">
              Add a login to prevent unauthorized access. This is optional — you can always enable it later in Settings.
            </p>

            {onboardRecoveryKey ? (
              <div className="space-y-4">
                <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-4">
                  <p className="text-[10px] uppercase tracking-widest text-yellow-500 mb-2">
                    Save Your Recovery Key
                  </p>
                  <p className="font-mono text-sm text-foreground select-all break-all mb-2">
                    {onboardRecoveryKey}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    You'll need this if you forget your password. Save it somewhere safe — it's shown only once.
                  </p>
                  <Button size="sm" className="mt-2" onClick={() => { navigator.clipboard.writeText(onboardRecoveryKey); toast.success("Copied to clipboard"); }}>
                    Copy to clipboard
                  </Button>
                </div>
                <Button size="sm" onClick={() => setStep(8)} className="w-full">
                  I've saved it — continue
                </Button>
              </div>
            ) : wantAuth === null ? (
              <div className="flex gap-3">
                <Button size="sm" onClick={() => setWantAuth(true)} className="flex-1">
                  Yes, set up login
                </Button>
                <Button size="sm" variant="outline" onClick={() => setStep(8)} className="flex-1">
                  Skip for now
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground">Method</label>
                  <select
                    className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"
                    value={authMethod}
                    onChange={(e) => setAuthMethod(e.target.value as "password" | "pin")}
                  >
                    <option value="password">Username & Password</option>
                    <option value="pin">PIN / Passphrase</option>
                  </select>
                </div>
                {authMethod === "password" && (
                  <>
                    <div>
                      <label className="text-xs text-muted-foreground">Username</label>
                      <Input value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} className="mt-1 bg-input" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">Password (min 6 chars)</label>
                      <Input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} className="mt-1 bg-input" />
                    </div>
                  </>
                )}
                {authMethod === "pin" && (
                  <div>
                    <label className="text-xs text-muted-foreground">PIN / Passphrase (min 4 chars)</label>
                    <Input type="password" value={authPin} onChange={(e) => setAuthPin(e.target.value)} className="mt-1 bg-input" />
                  </div>
                )}
                {authSetupError && <p className="text-xs text-destructive">{authSetupError}</p>}
                <div className="flex gap-2">
                  <Button size="sm" disabled={
                    authMethod === "password"
                      ? !authUsername || authPassword.length < 6
                      : authPin.length < 4
                  } onClick={async () => {
                    setAuthSetupError("");
                    try {
                      const body = authMethod === "password"
                        ? { method: "password" as const, username: authUsername, password: authPassword }
                        : { method: "pin" as const, pin: authPin };
                      const result = await api.auth.setup(body);
                      setOnboardRecoveryKey(result.recoveryKey);
                      setAuthPassword(""); setAuthPin(""); setAuthUsername("");
                      await refreshAuth();
                    } catch (err) {
                      setAuthSetupError(err instanceof Error ? err.message : "Setup failed");
                    }
                  }}>
                    Enable
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setWantAuth(null); }}>
                    Back
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 8 && (
          <div className="flex flex-col items-center py-6 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/15">
              <span className="text-2xl">&#10024;</span>
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">
              You're all set
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              {aiName || "Chvor"} is ready to go{name ? `, ${name}` : ""}.
            </p>
            <p className="mb-6 max-w-xs text-[11px] text-muted-foreground/60">
              Everything you configured can be changed anytime in Settings. Start a conversation to see your AI in action.
            </p>
            <Button size="sm" onClick={handleFinish} className="px-6">
              Start chatting
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
