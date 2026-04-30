import { useEffect, useState, useCallback } from "react";
import type { CredentialSummary, ChatType, ApiKeyInfo, ProviderField, IntegrationResolution } from "@chvor/shared";
import { toast } from "sonner";
import { useFeatureStore, type RegistryEntryWithStatus } from "../../stores/feature-store";
import { useConfigStore } from "../../stores/config-store";
import { useSessionStore } from "../../stores/session-store";
import { CredentialList } from "../credentials/CredentialList";
import { AddCredentialDialog } from "../credentials/AddCredentialDialog";
import { CredentialForm } from "../credentials/CredentialForm";
import { SessionCredentialPins } from "../credentials/SessionCredentialPins";
import { VoiceSettingsContent } from "./VoiceSettingsContent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

type SettingsTab = "api-keys" | "voice" | "security" | "sessions" | "backup";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "api-keys", label: "API Keys" },
  { id: "voice", label: "Voice" },
  { id: "security", label: "Security" },
  { id: "sessions", label: "Sessions" },
  { id: "backup", label: "Backup" },
];

const RETENTION_OPTIONS = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "Forever" },
];

export function CredentialsContent() {
  const {
    fetchCredentials: fetchAll,
    credentialsLoading: loading,
    credentialsError: error,
    credentials,
    addCredential,
  } = useFeatureStore();
  const { retentionConfig: retention, fetchRetentionConfig: fetchConfig, updateRetentionConfig: updateConfig } = useConfigStore();
  const registryStore = useFeatureStore();
  const [showAdd, setShowAdd] = useState(false);
  const [editingCredential, setEditingCredential] = useState<CredentialSummary | null>(null);

  // Registry browsing state
  const [registrySearch, setRegistrySearch] = useState("");
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);

  // AI research state
  const [researchQuery, setResearchQuery] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchResult, setResearchResult] = useState<IntegrationResolution | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
    fetchConfig();
  }, [fetchAll, fetchConfig]);

  // Load registry entries with credential requirements
  useEffect(() => {
    if (!registryLoaded) {
      registryStore.search("", undefined, "tool").then(() => setRegistryLoaded(true));
    }
  }, [registryLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter registry entries that have credential requirements
  const registryToolsWithCreds = registryStore.entries.filter(
    (e) => e.kind === "tool" && e.requires?.credentials?.length
  );

  const filteredRegistryTools = registrySearch.trim()
    ? registryToolsWithCreds.filter(
        (e) =>
          e.name.toLowerCase().includes(registrySearch.toLowerCase()) ||
          e.description.toLowerCase().includes(registrySearch.toLowerCase())
      )
    : registryToolsWithCreds;

  const handleRegistryInstall = useCallback(async (entry: RegistryEntryWithStatus) => {
    setInstallingId(entry.id);
    try {
      await registryStore.install(entry.id, entry.kind);
      toast.success(`Installed ${entry.name}`);
    } catch {
      toast.error(`Failed to install ${entry.name}`);
    } finally {
      setInstallingId(null);
    }
  }, [registryStore]);

  const handleAiResearch = useCallback(async () => {
    const q = researchQuery.trim() || registrySearch.trim();
    if (!q || q.length < 2) return;
    setResearching(true);
    setResearchError(null);
    setResearchResult(null);
    try {
      const res = await fetch(`/api/integrations/research?q=${encodeURIComponent(q)}`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as IntegrationResolution;
      setResearchResult(data);
    } catch (err) {
      setResearchError(err instanceof Error ? err.message : "Research failed");
    } finally {
      setResearching(false);
    }
  }, [researchQuery, registrySearch]);

  const handleResearchSubmit = useCallback(
    async (formData: { name: string; fields: Record<string, string> }) => {
      if (!researchResult) return;
      try {
        const summary = await api.credentials.create({
          name: formData.name,
          type: researchResult.credentialType,
          data: formData.fields,
        });
        addCredential(summary);
        setResearchResult(null);
        setResearchQuery("");
        toast.success("Credential saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    },
    [researchResult, addCredential],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Providers [{credentials.length}]
        </h3>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          + Add
        </Button>
      </div>

      {loading && (
        <p className="text-xs text-muted-foreground">Loading...</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <SessionCredentialPins />
      {!loading && <CredentialList onEdit={setEditingCredential} />}

      {showAdd && <AddCredentialDialog onClose={() => setShowAdd(false)} />}
      {editingCredential && (
        <AddCredentialDialog
          onClose={() => setEditingCredential(null)}
          editCredential={editingCredential}
        />
      )}

      {/* Available from Registry */}
      <div className="mt-2 border-t border-border pt-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Available from Registry
        </h3>
        <Input
          type="text"
          value={registrySearch}
          onChange={(e) => setRegistrySearch(e.target.value)}
          placeholder="Search tools..."
          className="mb-3 text-xs"
        />

        {registryStore.registryLoading && (
          <p className="text-xs text-muted-foreground">Loading registry...</p>
        )}

        {!registryStore.registryLoading && filteredRegistryTools.length > 0 && (
          <div className="flex flex-col gap-1.5 mb-3">
            {filteredRegistryTools.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-md border border-border/50 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-foreground truncate">{entry.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {entry.description}
                  </p>
                  {entry.requires?.credentials && (
                    <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                      Requires: {entry.requires.credentials.join(", ")}
                    </p>
                  )}
                </div>
                {entry.installed ? (
                  <span className="shrink-0 ml-2 text-[10px] text-green-400">Installed</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 ml-2 text-[10px]"
                    disabled={installingId === entry.id}
                    onClick={() => handleRegistryInstall(entry)}
                  >
                    {installingId === entry.id ? "Installing..." : "Install"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {!registryStore.registryLoading && filteredRegistryTools.length === 0 && registrySearch.trim() && (
          <p className="text-[10px] text-muted-foreground/60 mb-3">
            No registry tools found for "{registrySearch}".
          </p>
        )}

        {/* AI Research fallback */}
        <div className="mt-2 pt-2 border-t border-border/30">
          <p className="text-[10px] text-muted-foreground/70 mb-2">
            Can't find what you need? Research any service with AI.
          </p>
          <div className="flex gap-1.5 mb-3">
            <Input
              type="text"
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              placeholder="e.g. Notion, Linear, Airtable..."
              className="text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAiResearch();
              }}
            />
            <Button
              size="sm"
              onClick={handleAiResearch}
              disabled={researching || (researchQuery.trim().length < 2 && registrySearch.trim().length < 2)}
            >
              {researching ? "Researching..." : "Research with AI"}
            </Button>
          </div>

          {researchError && (
            <p className="text-xs text-destructive mb-2">{researchError}</p>
          )}

          {researchResult && (
            <CredentialForm
              providerName={researchResult.name}
              credentialType={researchResult.credentialType}
              fields={researchResult.fields}
              suggestedName={`${researchResult.name} API Key`}
              source={researchResult.source}
              confidence={researchResult.proposal?.confidence}
              helpText={researchResult.proposal?.helpText}
              allowFieldEditing={researchResult.source === "ai-research"}
              onSubmit={handleResearchSubmit}
              onCancel={() => setResearchResult(null)}
            />
          )}
        </div>
      </div>

      {/* Data & Retention */}
      <div className="mt-2 border-t border-border pt-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Data & Retention
        </h3>

        {retention && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">
                Keep sessions for
              </label>
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                value={retention.sessionMaxAgeDays}
                onChange={(e) =>
                  updateConfig({ sessionMaxAgeDays: Number(e.target.value) })
                }
              >
                {RETENTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={retention.archiveBeforeDelete}
                onChange={(e) =>
                  updateConfig({ archiveBeforeDelete: e.target.checked })
                }
              />
              Extract memories before deletion
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

export function SecurityContent() {
  const { authEnabled, authMethod, checkStatus, apiKeys, fetchApiKeys } = useSessionStore();
  const [loading, setLoading] = useState(true);

  // Auth setup state
  const [showSetup, setShowSetup] = useState(false);
  const [setupMethod, setSetupMethod] = useState<"password" | "pin">("password");
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [setupError, setSetupError] = useState("");

  // API key state
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [disableConfirm, setDisableConfirm] = useState(false);
  const [disableCredential, setDisableCredential] = useState("");
  const [disableError, setDisableError] = useState("");

  useEffect(() => {
    setLoading(false);
    if (authEnabled) fetchApiKeys();
  }, [authEnabled, fetchApiKeys]);

  const handleSetup = async () => {
    setSetupError("");
    try {
      const body = setupMethod === "password"
        ? { method: "password" as const, username: setupUsername, password: setupPassword }
        : { method: "pin" as const, pin: setupPin };
      const result = await api.auth.setup(body);
      setRecoveryKey(result.recoveryKey);
      setShowSetup(false);
      await checkStatus();
      fetchApiKeys();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : "Setup failed");
    }
  };

  const handleDisable = async () => {
    setDisableError("");
    try {
      const body = authMethod === "password"
        ? { password: disableCredential, username: setupUsername || undefined }
        : { pin: disableCredential };
      await api.auth.disable(body);
      setDisableConfirm(false);
      setDisableCredential("");
      await checkStatus();
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : "Invalid credentials");
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
    try {
      const result = await api.auth.createApiKey({ name: newKeyName.trim() });
      setCreatedKey(result.key);
      setNewKeyName("");
      fetchApiKeys();
    } catch {
      // ignore
    }
  };

  const handleRevokeKey = async (id: string) => {
    await api.auth.revokeApiKey(id);
    fetchApiKeys();
  };

  if (loading) return <p className="text-xs text-muted-foreground">Loading...</p>;

  return (
    <div className="flex flex-col gap-5">
      {/* Authentication */}
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Authentication
      </h3>

      {recoveryKey && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
          <p className="text-[10px] uppercase tracking-widest text-yellow-500 mb-2">
            Save Your Recovery Key
          </p>
          <p className="font-mono text-sm text-foreground select-all break-all mb-2">
            {recoveryKey}
          </p>
          <p className="text-[10px] text-muted-foreground">
            This key is shown only once. Save it somewhere safe — you'll need it if you forget your password.
          </p>
          <Button size="sm" className="mt-2" onClick={() => {
            navigator.clipboard.writeText(recoveryKey);
            toast.success("Copied to clipboard");
          }}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" className="mt-2 ml-2" onClick={() => setRecoveryKey("")}>
            Dismiss
          </Button>
        </div>
      )}

      {!authEnabled && !showSetup && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Authentication is <span className="text-foreground font-medium">disabled</span>.
            Your instance is accessible without login.
          </p>
          <Button size="sm" onClick={() => setShowSetup(true)}>
            Enable Authentication
          </Button>
        </div>
      )}

      {showSetup && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <div className="flex flex-col gap-2">
            <label className="text-xs text-muted-foreground">Method</label>
            <select
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              value={setupMethod}
              onChange={(e) => setSetupMethod(e.target.value as "password" | "pin")}
            >
              <option value="password">Username & Password</option>
              <option value="pin">PIN / Passphrase</option>
            </select>
          </div>
          {setupMethod === "password" && (
            <>
              <div>
                <label className="text-xs text-muted-foreground">Username</label>
                <Input value={setupUsername} onChange={(e) => setSetupUsername(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Password (min 6 chars)</label>
                <Input type="password" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} className="mt-1" />
              </div>
            </>
          )}
          {setupMethod === "pin" && (
            <div>
              <label className="text-xs text-muted-foreground">PIN / Passphrase (min 4 chars)</label>
              <Input type="password" value={setupPin} onChange={(e) => setSetupPin(e.target.value)} className="mt-1" />
            </div>
          )}
          {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSetup} disabled={
              setupMethod === "password"
                ? !setupUsername || setupPassword.length < 6
                : setupPin.length < 4
            }>Enable</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSetup(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {authEnabled && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Authentication is <span className="text-green-400 font-medium">enabled</span>.
          </p>
          {!disableConfirm ? (
            <Button size="sm" variant="destructive" onClick={() => setDisableConfirm(true)}>
              Disable Authentication
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-destructive">Enter your {authMethod === "password" ? "password" : "PIN"} to confirm:</p>
              <input
                type="password"
                className="w-full bg-background border border-border rounded px-2 py-1 text-xs"
                placeholder={authMethod === "password" ? "Password" : "PIN"}
                value={disableCredential}
                onChange={(e) => setDisableCredential(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleDisable()}
                autoFocus
              />
              {disableError && <p className="text-[10px] text-destructive">{disableError}</p>}
              <div className="flex items-center gap-2">
                <Button size="sm" variant="destructive" onClick={handleDisable} disabled={!disableCredential}>Yes, disable</Button>
                <Button size="sm" variant="ghost" onClick={() => { setDisableConfirm(false); setDisableCredential(""); setDisableError(""); }}>Cancel</Button>
              </div>
            </div>
          )}

          {/* API Keys */}
          <div className="mt-2 border-t border-border pt-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              API Keys
            </h3>
            <p className="text-[10px] text-muted-foreground/60 mb-3">
              Generate keys for programmatic access (CLI, scripts, integrations).
            </p>

            {createdKey && (
              <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 mb-3">
                <p className="text-[10px] uppercase tracking-widest text-green-500 mb-1">
                  New API Key (shown once)
                </p>
                <p className="font-mono text-xs text-foreground select-all break-all">
                  {createdKey}
                </p>
                <Button size="sm" className="mt-2" onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                  toast.success("Copied to clipboard");
                }}>
                  Copy
                </Button>
                <Button size="sm" variant="ghost" className="mt-2 ml-2" onClick={() => setCreatedKey("")}>
                  Dismiss
                </Button>
              </div>
            )}

            <div className="flex gap-1.5 mb-3">
              <Input
                placeholder="Key name (e.g. my-script)"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="text-xs"
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateKey(); }}
              />
              <Button size="sm" onClick={handleCreateKey}>Generate</Button>
            </div>

            {apiKeys.filter(k => !k.revokedAt).map((key) => (
              <div key={key.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 mb-1.5">
                <div>
                  <p className="text-xs text-foreground">{key.name}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    chvor_{key.prefix}...
                    {key.lastUsedAt && ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleRevokeKey(key.id)}>
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shell command approval moved to Permissions panel */}
    </div>
  );
}

const HOUR_OPTIONS = [
  { value: -1, label: "Disabled" },
  ...Array.from({ length: 24 }, (_, i) => ({
    value: i,
    label: `${String(i).padStart(2, "0")}:00`,
  })),
];

const CHAT_TYPES: { id: ChatType; label: string }[] = [
  { id: "dm", label: "Direct Messages" },
  { id: "group", label: "Group Chats" },
  { id: "thread", label: "Threads" },
];

export function SessionsContent() {
  const { sessionLifecycleConfig: config, fetchSessionLifecycleConfig: fetchConfig, updateSessionLifecycleConfig: updateConfig } = useConfigStore();
  const [triggerInput, setTriggerInput] = useState("");

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  if (!config) return <p className="text-xs text-muted-foreground">Loading...</p>;

  const addTrigger = () => {
    const t = triggerInput.trim();
    if (t && !config.resetTriggers.includes(t)) {
      updateConfig({ resetTriggers: [...config.resetTriggers, t] });
    }
    setTriggerInput("");
  };

  const removeTrigger = (trigger: string) => {
    updateConfig({ resetTriggers: config.resetTriggers.filter((t) => t !== trigger) });
  };

  return (
    <div className="flex flex-col gap-5">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Session Auto-Reset
      </h3>

      {/* Default policy */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Idle timeout (minutes)</label>
          <input
            type="number"
            min={0}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={config.defaultPolicy.idleTimeoutMinutes}
            onChange={(e) =>
              updateConfig({ defaultPolicy: { idleTimeoutMinutes: Math.max(0, Number(e.target.value)) } })
            }
          />
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Reset session after N minutes of inactivity. 0 = disabled.
        </p>

        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Daily reset at hour</label>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={config.defaultPolicy.dailyResetHour ?? -1}
            onChange={(e) => {
              const v = Number(e.target.value);
              updateConfig({ defaultPolicy: { dailyResetHour: v < 0 ? null : v } });
            }}
          >
            {HOUR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Max messages per session</label>
          <input
            type="number"
            min={0}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={config.defaultPolicy.maxMessages}
            onChange={(e) =>
              updateConfig({ defaultPolicy: { maxMessages: Math.max(0, Number(e.target.value)) } })
            }
          />
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Auto-reset after this many messages. 0 = unlimited.
        </p>
      </div>

      {/* Per-chat-type overrides */}
      <div className="border-t border-border pt-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Per-Chat-Type Overrides
        </h3>
        <p className="text-[10px] text-muted-foreground/60 mb-3">
          Leave at 0 / Disabled to use defaults above.
        </p>
        {CHAT_TYPES.map(({ id, label }) => {
          const policy = config.chatTypePolicies[id];
          return (
            <div key={id} className="mb-3 rounded-md border border-border/50 p-3">
              <p className="text-[11px] font-medium text-foreground mb-2">{label}</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Idle timeout</label>
                  <input
                    type="number"
                    min={0}
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    value={policy?.idleTimeoutMinutes ?? 0}
                    onChange={(e) =>
                      updateConfig({
                        chatTypePolicies: { [id]: { idleTimeoutMinutes: Math.max(0, Number(e.target.value)) } },
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Daily reset</label>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    value={policy?.dailyResetHour ?? -1}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      updateConfig({
                        chatTypePolicies: { [id]: { dailyResetHour: v < 0 ? null : v } },
                      });
                    }}
                  >
                    {HOUR_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-muted-foreground">Max messages</label>
                  <input
                    type="number"
                    min={0}
                    className="w-20 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    value={policy?.maxMessages ?? 0}
                    onChange={(e) =>
                      updateConfig({
                        chatTypePolicies: { [id]: { maxMessages: Math.max(0, Number(e.target.value)) } },
                      })
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reset triggers */}
      <div className="border-t border-border pt-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
          Reset Triggers
        </h3>
        <p className="text-[10px] text-muted-foreground/60 mb-2">
          Chat commands that reset the session (e.g. /new, /reset).
        </p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {config.resetTriggers.map((trigger) => (
            <span
              key={trigger}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] text-foreground"
            >
              {trigger}
              <button
                onClick={() => removeTrigger(trigger)}
                className="text-muted-foreground hover:text-destructive"
              >
                x
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            type="text"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            placeholder="/command"
            value={triggerInput}
            onChange={(e) => setTriggerInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTrigger();
              }
            }}
          />
          <Button size="sm" onClick={addTrigger}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

const INTERVAL_OPTIONS = [
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 48, label: "Every 48 hours" },
  { value: 168, label: "Weekly" },
];

const MAX_AGE_OPTIONS = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "Forever" },
];

export function BackupContent() {
  const {
    backups, backupConfig: config, creating, restoring, backupError: error,
    fetchBackups, fetchBackupConfig: fetchConfig, updateBackupConfig: updateConfig, createBackup, deleteBackup, restoreBackup,
  } = useConfigStore();
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [localMaxCount, setLocalMaxCount] = useState<string>("");

  useEffect(() => {
    fetchBackups();
    fetchConfig();
  }, [fetchBackups, fetchConfig]);

  useEffect(() => {
    if (config) setLocalMaxCount(String(config.maxCount));
  }, [config?.maxCount]);

  const handleRestoreSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingRestoreFile(file);
    e.target.value = "";
  };

  const handleRestoreConfirm = async () => {
    if (!pendingRestoreFile) return;
    const file = pendingRestoreFile;
    setPendingRestoreFile(null);
    const success = await restoreBackup(file);
    if (success) {
      toast.success("Restore complete. The server is restarting — please refresh in a few seconds.");
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId) return;
    await deleteBackup(deleteConfirmId);
    setDeleteConfirmId(null);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleExportTemplate = async () => {
    try {
      const yaml = await api.templates.exportYaml();
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "template.yaml";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Template exported");
    } catch {
      toast.error("Failed to export template");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Export as Template */}
      <section>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Export as Template
        </h3>
        <p className="text-[10px] text-muted-foreground mb-2">
          Export your current assistant configuration (persona, skills, tools, schedules) as a shareable template. Credential secrets are not included.
        </p>
        <Button size="sm" variant="outline" onClick={handleExportTemplate}>
          Export Template
        </Button>
      </section>

      {/* Manual Backup / Restore */}
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Manual Backup & Restore
      </h3>

      <div className="flex gap-2">
        <Button size="sm" onClick={() => createBackup()} disabled={creating}>
          {creating ? "Creating..." : "Create Backup"}
        </Button>
        <label className="cursor-pointer">
          <span className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted">
            {restoring ? "Restoring..." : "Restore from File"}
          </span>
          <input type="file" accept=".chvor-backup" className="hidden" onChange={handleRestoreSelect} disabled={restoring} />
        </label>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Backup List */}
      {backups.length > 0 && (
        <div className="border-t border-border pt-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Backups [{backups.length}]
          </h3>
          {backups.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-md border border-border/50 p-2 mb-1.5">
              <div>
                <p className="text-xs text-foreground truncate max-w-[200px]">{b.filename}</p>
                <p className="text-[10px] text-muted-foreground">
                  {new Date(b.createdAt).toLocaleString()} · {formatSize(b.sizeBytes)}
                </p>
              </div>
              <div className="flex gap-1">
                <a
                  href={`/api/backup/download/${encodeURIComponent(b.id)}`}
                  download
                  className="inline-flex items-center rounded-md px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
                >
                  Download
                </a>
                <Button size="sm" variant="ghost" className="text-destructive text-[10px]" onClick={() => setDeleteConfirmId(b.id)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Auto-Backup Settings */}
      {config && (
        <div className="border-t border-border pt-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Scheduled Backups
          </h3>

          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer mb-3">
            <input
              type="checkbox"
              className="rounded border-border"
              checked={config.enabled}
              onChange={(e) => updateConfig({ enabled: e.target.checked })}
            />
            Enable automatic backups
          </label>

          {config.enabled && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Interval</label>
                <select
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={config.intervalHours}
                  onChange={(e) => updateConfig({ intervalHours: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Max backups to keep</label>
                <input
                  type="number"
                  min={1}
                  className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={localMaxCount}
                  onChange={(e) => setLocalMaxCount(e.target.value)}
                  onBlur={() => {
                    const n = Math.max(1, parseInt(localMaxCount, 10) || 1);
                    setLocalMaxCount(String(n));
                    if (n !== config.maxCount) updateConfig({ maxCount: n });
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Max age</label>
                <select
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                  value={config.maxAgeDays}
                  onChange={(e) => updateConfig({ maxAgeDays: Number(e.target.value) })}
                >
                  {MAX_AGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {config.lastRunAt && (
                <p className="text-[10px] text-muted-foreground/60">
                  Last backup: {new Date(config.lastRunAt).toLocaleString()}
                </p>
              )}
              {config.lastError && (
                <p className="text-[10px] text-destructive">
                  Last error: {config.lastError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Restore confirmation */}
      {pendingRestoreFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-background p-5 shadow-lg max-w-sm">
            <p className="text-sm font-medium text-foreground mb-2">Confirm Restore</p>
            <p className="text-xs text-muted-foreground mb-4">
              This will replace your current database, skills, and tools with the backup contents. A safety backup will be created first. The server will restart.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPendingRestoreFile(null)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleRestoreConfirm} disabled={restoring}>
                {restoring ? "Restoring..." : "Restore"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-background p-5 shadow-lg max-w-sm">
            <p className="text-sm font-medium text-foreground mb-2">Delete Backup</p>
            <p className="text-xs text-muted-foreground mb-4">
              This backup will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={handleDeleteConfirm}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPanel() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("api-keys");

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex shrink-0 border-b border-border/50">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex-1 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] transition-colors",
              activeTab === tab.id
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-5">
        {activeTab === "api-keys" && <CredentialsContent />}
        {activeTab === "voice" && <VoiceSettingsContent />}
        {activeTab === "security" && <SecurityContent />}
        {activeTab === "sessions" && <SessionsContent />}
        {activeTab === "backup" && <BackupContent />}
      </div>
    </div>
  );
}
