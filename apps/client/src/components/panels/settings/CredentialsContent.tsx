import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { CredentialSummary, IntegrationResolution } from "@chvor/shared";
import { useConfigStore } from "../../../stores/config-store";
import { useFeatureStore, type RegistryEntryWithStatus } from "../../../stores/feature-store";
import { AddCredentialDialog } from "../../credentials/AddCredentialDialog";
import { CredentialForm } from "../../credentials/CredentialForm";
import { CredentialList } from "../../credentials/CredentialList";
import { SessionCredentialPins } from "../../credentials/SessionCredentialPins";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

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
