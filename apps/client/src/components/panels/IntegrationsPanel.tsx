import { useEffect, useState } from "react";
import { useCredentialStore } from "../../stores/credential-store";
import { AddCredentialDialog } from "../credentials/AddCredentialDialog";
import { ProviderIcon } from "@/components/ui/ProviderIcon";

export function IntegrationsPanel() {
  const { credentials, integrationProviders, fetchAll, loading } = useCredentialStore();
  const [showAdd, setShowAdd] = useState(false);
  const [editingCredential, setEditingCredential] = useState<typeof credentials[0] | null>(null);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Filter credentials to only integration providers
  const integrationCredTypes = new Set(integrationProviders.map((p) => p.credentialType));
  const integrationCredentials = credentials.filter((c) => integrationCredTypes.has(c.type));

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header with add button */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {integrationCredentials.length} integration{integrationCredentials.length !== 1 ? "s" : ""} connected
        </span>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add
        </button>
      </div>

      {/* Integration list */}
      {integrationCredentials.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/50 p-8 text-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/30">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
          <div>
            <p className="text-xs font-medium text-muted-foreground">No integrations connected</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/60">
              Connect Telegram, Discord, Slack, and more
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {integrationCredentials.map((cred) => {
            const providerDef = integrationProviders.find((p) => p.credentialType === cred.type);
            return (
              <div
                key={cred.id}
                className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/10 p-3 transition-colors hover:bg-muted/20"
              >
                {providerDef && <ProviderIcon icon={providerDef.icon} size={18} />}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">{cred.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      {cred.type}
                    </span>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${
                      cred.testStatus === "success" ? "bg-green-500" :
                      cred.testStatus === "failed" ? "bg-red-500" :
                      "bg-muted-foreground/40"
                    }`} />
                  </div>
                </div>
                <button
                  onClick={() => setEditingCredential(cred)}
                  className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors shrink-0"
                  title="Edit"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Available integrations */}
      {(() => {
        const connectedTypes = new Set(integrationCredentials.map((c) => c.type));
        const unconnected = integrationProviders.filter((p) => !connectedTypes.has(p.credentialType));
        if (unconnected.length === 0) return null;
        return (
          <div>
            <p className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Available integrations
            </p>
            <div className="flex flex-wrap gap-1">
              {unconnected.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setShowAdd(true)}
                  className="flex items-center gap-1.5 rounded-md border border-dashed border-border/40 px-2 py-1 text-[10px] text-muted-foreground/60 hover:border-primary/40 hover:text-primary/80 transition-all"
                >
                  <ProviderIcon icon={p.icon} size={14} className="opacity-50" />
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Add dialog */}
      {showAdd && (
        <AddCredentialDialog
          onClose={() => { setShowAdd(false); fetchAll(); }}
          filter="integration"
        />
      )}

      {/* Edit dialog */}
      {editingCredential && (
        <AddCredentialDialog
          onClose={() => { setEditingCredential(null); fetchAll(); }}
          editCredential={editingCredential}
        />
      )}
    </div>
  );
}
