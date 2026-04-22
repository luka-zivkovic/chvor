import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { AddCredentialDialog } from "../credentials/AddCredentialDialog";
import { useFeatureStore } from "../../stores/feature-store";
import type {
  IntegrationCatalogEntry,
  IntegrationCategory,
  IntegrationResolution,
} from "@chvor/shared";

const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  llm: "LLM",
  embedding: "Embedding",
  integration: "Integration",
  "image-gen": "Image",
  oauth: "OAuth",
  registry: "Registry",
};

const CATEGORY_ORDER: IntegrationCategory[] = [
  "integration",
  "oauth",
  "llm",
  "embedding",
  "image-gen",
  "registry",
];

const FILTERS: Array<{ value: IntegrationCategory | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "integration", label: "Services" },
  { value: "oauth", label: "OAuth" },
  { value: "llm", label: "LLM" },
  { value: "image-gen", label: "Image" },
  { value: "registry", label: "From registry" },
];

/**
 * Browseable catalog of every service Chvor knows how to connect to —
 * built-in providers (LLM, integration, OAuth, image-gen) plus chvor-registry
 * entries that ship a credential schema. Falls back to AI-research (Tier 3)
 * for anything not listed via the "Request a new integration" CTA at the
 * bottom; the result is funneled into the same AddCredentialDialog flow used
 * for built-ins so the user gets the same affordances either way.
 */
export function IntegrationCatalogPanel() {
  const [entries, setEntries] = useState<IntegrationCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<IntegrationCategory | "all">("all");

  const [addCredType, setAddCredType] = useState<string | null>(null);
  const [requestText, setRequestText] = useState("");
  const [requestSpecUrl, setRequestSpecUrl] = useState("");
  const [showSpecUrlOverride, setShowSpecUrlOverride] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [requestResult, setRequestResult] = useState<IntegrationResolution | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const { fetchCredentials: refetchCredentials } = useFeatureStore();

  const load = async () => {
    setError(null);
    try {
      const res = await api.integrations.catalog();
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    return entries
      .filter((e) => filter === "all" || e.category === filter)
      .filter((e) => {
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q)
          || e.description.toLowerCase().includes(q)
          || (e.credentialType?.toLowerCase().includes(q) ?? false)
          || (e.tags?.some((t) => t.toLowerCase().includes(q)) ?? false)
        );
      })
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        const ca = CATEGORY_ORDER.indexOf(a.category);
        const cb = CATEGORY_ORDER.indexOf(b.category);
        if (ca !== cb) return ca - cb;
        return a.name.localeCompare(b.name);
      });
  }, [entries, search, filter]);

  const installedCount = entries?.filter((e) => e.installed).length ?? 0;

  const handleConnect = (e: IntegrationCatalogEntry) => {
    if (!e.credentialType) return;
    setAddCredType(e.credentialType);
  };

  const handleRequestIntegration = async () => {
    const q = requestText.trim();
    if (q.length < 2) return;
    const specUrl = requestSpecUrl.trim();
    if (specUrl && !specUrl.startsWith("https://")) {
      setRequestError("Spec URL override must start with https://");
      return;
    }
    setRequesting(true);
    setRequestError(null);
    setRequestResult(null);
    try {
      const res = await api.integrations.research(q, specUrl ? { specUrl } : undefined);
      setRequestResult(res);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  };

  const handleAcceptResearched = () => {
    if (!requestResult?.credentialType) return;
    setAddCredType(requestResult.credentialType);
    setRequestResult(null);
    setRequestText("");
  };

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
        Failed to load catalog: {error}
      </div>
    );
  }

  if (entries === null) {
    return <p className="text-xs text-muted-foreground">Loading catalog…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          {installedCount} of {entries.length} connected
        </span>
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search services, tags, credential types…"
        className="w-full rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 text-xs focus:border-primary/50 focus:outline-none"
      />

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
              filter === f.value
                ? "bg-primary/15 text-primary"
                : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 italic">
          Nothing matches your search.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((e) => (
            <CatalogRow key={e.id} entry={e} onConnect={() => handleConnect(e)} />
          ))}
        </div>
      )}

      <div className="mt-2 rounded-lg border border-dashed border-border/50 p-3 space-y-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Don't see your service?
        </p>
        <p className="text-[10px] text-muted-foreground">
          Chvor will research it and propose a credential schema. If the service
          publishes an OpenAPI spec, tools are synthesized automatically.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !requesting) handleRequestIntegration(); }}
            placeholder="e.g. quickbooks, monday.com, freshbooks"
            className="flex-1 rounded-md border border-border/50 bg-background/40 px-2 py-1 text-xs focus:border-primary/50 focus:outline-none"
          />
          <button
            onClick={handleRequestIntegration}
            disabled={requesting || requestText.trim().length < 2}
            className="rounded-md bg-primary/10 px-3 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
          >
            {requesting ? "Researching…" : "Research"}
          </button>
        </div>

        <button
          onClick={() => setShowSpecUrlOverride((v) => !v)}
          className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
        >
          {showSpecUrlOverride ? "Hide spec URL override" : "I have an OpenAPI spec URL →"}
        </button>

        {showSpecUrlOverride && (
          <input
            type="url"
            value={requestSpecUrl}
            onChange={(e) => setRequestSpecUrl(e.target.value)}
            placeholder="https://api.example.com/openapi.json"
            className="w-full rounded-md border border-border/50 bg-background/40 px-2 py-1 text-xs focus:border-primary/50 focus:outline-none"
          />
        )}

        {requestError && (
          <p className="text-[10px] text-destructive">{requestError}</p>
        )}

        {requestResult && (
          <div className="rounded-md border border-border/50 bg-muted/20 p-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{requestResult.name}</span>
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0 text-[9px] text-amber-500">
                {requestResult.source === "ai-research"
                  ? `discovered (${requestResult.proposal?.confidence ?? "low"})`
                  : requestResult.source.replace("-", " ")}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Credential type: <code className="font-mono">{requestResult.credentialType}</code>
              {" · "}
              {requestResult.fields.length} field{requestResult.fields.length !== 1 ? "s" : ""}
              {requestResult.proposal?.authScheme && (
                <> · auth: {requestResult.proposal.authScheme}</>
              )}
            </p>
            <div className="flex justify-end">
              <button
                onClick={handleAcceptResearched}
                className="rounded-md bg-primary/15 px-3 py-1 text-[10px] font-medium text-primary hover:bg-primary/25 transition-colors"
              >
                Continue setup →
              </button>
            </div>
          </div>
        )}
      </div>

      {addCredType && (
        <AddCredentialDialog
          initialCredType={addCredType}
          onClose={() => {
            setAddCredType(null);
            refetchCredentials();
            load();
          }}
        />
      )}
    </div>
  );
}

function CatalogRow({
  entry,
  onConnect,
}: {
  entry: IntegrationCatalogEntry;
  onConnect: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/40 bg-muted/5 px-2.5 py-2 transition-colors hover:bg-muted/15">
      {entry.icon ? (
        <ProviderIcon icon={entry.icon} size={16} className={entry.installed ? "" : "opacity-60"} />
      ) : (
        <div className="h-4 w-4 rounded-sm bg-muted/30" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{entry.name}</span>
          <span className="rounded-full bg-muted/30 px-1.5 py-0 text-[8px] uppercase tracking-wider text-muted-foreground">
            {CATEGORY_LABEL[entry.category]}
          </span>
          {entry.installed && (
            <span className="text-[9px] text-emerald-500">● connected</span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground line-clamp-1">{entry.description}</p>
      </div>
      <button
        onClick={onConnect}
        disabled={!entry.credentialType}
        className={`shrink-0 rounded-md px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
          entry.installed
            ? "border border-border/50 text-muted-foreground hover:bg-muted/30"
            : "bg-primary/10 text-primary hover:bg-primary/20"
        } disabled:opacity-40`}
      >
        {entry.installed ? "Manage" : "Connect"}
      </button>
    </div>
  );
}
