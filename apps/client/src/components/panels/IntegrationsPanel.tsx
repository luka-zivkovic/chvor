import { useEffect, useState } from "react";
import { useFeatureStore } from "../../stores/feature-store";
import { AddCredentialDialog } from "../credentials/AddCredentialDialog";
import { OAuthConnectButton } from "../credentials/OAuthConnectButton";
import { IntegrationSetupFlow } from "../integrations/IntegrationSetupFlow";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { api } from "@/lib/api";
import { useUIStore } from "../../stores/ui-store";
import type { IntegrationManifest, OAuthConnection } from "@chvor/shared";

interface ReauthenticationSetupTarget {
  manifest: IntegrationManifest;
  credentialType: string;
  manifestCredentialId: string;
  targetCredentialId: string;
  oauthCredentialId: string;
}

const REAUTHENTICATION_STATUSES = new Set(["expired", "revoked", "reauthentication-required"]);

function connectionNeedsReauthentication(connection: OAuthConnection): boolean {
  return (
    connection.needsReauthentication === true ||
    (connection.authStatus !== undefined && REAUTHENTICATION_STATUSES.has(connection.authStatus))
  );
}

function exactReauthenticationSetupTarget(
  connection: OAuthConnection,
  manifests: readonly IntegrationManifest[]
): ReauthenticationSetupTarget | undefined {
  const target = connection.reauthenticationTarget;
  if (!target || connection.credentialId !== target.oauthCredentialId) return undefined;
  const matching = manifests.filter(
    (manifest) =>
      manifest.id === target.integrationId && manifest.version === target.manifestVersion
  );
  if (matching.length !== 1) return undefined;
  const manifest = matching[0];
  const credential = manifest.credentials.find(
    (candidate) => candidate.id === target.manifestCredentialId
  );
  const declaration = manifest.oauth.find(
    (candidate) => candidate.id === target.oauthManifestCredentialId
  );
  if (
    !credential ||
    !declaration ||
    declaration.mode !== "direct" ||
    declaration.clientId.credentialId !== credential.id ||
    (declaration.clientSecret && declaration.clientSecret.credentialId !== credential.id)
  ) {
    return undefined;
  }
  return {
    manifest,
    credentialType: target.credentialType,
    manifestCredentialId: credential.id,
    targetCredentialId: target.targetCredentialId,
    oauthCredentialId: target.oauthCredentialId,
  };
}

export function IntegrationsPanel() {
  const {
    credentials,
    integrationProviders,
    oauthProviders,
    oauthConnections,
    hasComposioKey,
    fetchCredentials: fetchAll,
    fetchOAuthState,
    credentialsLoading: loading,
    credentialsError: error,
  } = useFeatureStore();
  const [showAdd, setShowAdd] = useState(false);
  const [addCredType, setAddCredType] = useState<string | undefined>(undefined);
  const [editingCredential, setEditingCredential] = useState<typeof credentials[0] | null>(null);
  const [composioExpanded, setComposioExpanded] = useState(false);
  const [reauthenticationTarget, setReauthenticationTarget] =
    useState<ReauthenticationSetupTarget | null>(null);
  const [reauthenticationLoadingId, setReauthenticationLoadingId] = useState<string | null>(null);
  const [reauthenticationError, setReauthenticationError] = useState<string | null>(null);
  const openPanel = useUIStore((s) => s.openPanel);

  useEffect(() => {
    fetchAll();
    fetchOAuthState();
  }, [fetchAll, fetchOAuthState]);

  // Filter credentials to only integration providers (exclude OAuth setup creds)
  const oauthSetupTypes = new Set(["google-oauth", "reddit-oauth", "composio"]);
  const integrationCredTypes = new Set(integrationProviders.map((p) => p.credentialType));
  const integrationCredentials = credentials.filter(
    (c) => integrationCredTypes.has(c.type) && !oauthSetupTypes.has(c.type),
  );

  // Split OAuth providers by method
  const directOAuthProviders = oauthProviders.filter((p) => p.method === "direct");
  const composioOAuthProviders = oauthProviders.filter((p) => p.method === "composio");

  // Available native integrations (exclude OAuth setup creds from the "available" list)
  const connectedTypes = new Set(integrationCredentials.map((c) => c.type));
  const unconnectedNative = integrationProviders.filter(
    (p) => !connectedTypes.has(p.credentialType) && !oauthSetupTypes.has(p.credentialType),
  );

  const handleAddWithProvider = (credType: string) => {
    setAddCredType(credType);
    setShowAdd(true);
  };

  const handleReauthenticate = async (connection: OAuthConnection) => {
    if (!connection.reauthenticationTarget) {
      openPanel("integration-catalog");
      return;
    }
    setReauthenticationLoadingId(connection.id);
    setReauthenticationError(null);
    try {
      const catalog = await api.integrations.manifests();
      const target = exactReauthenticationSetupTarget(connection, catalog.manifests);
      if (!target) {
        throw new Error(
          "The saved OAuth account no longer matches an active integration manifest."
        );
      }
      setReauthenticationTarget(target);
    } catch (reauthError) {
      setReauthenticationError(
        reauthError instanceof Error
          ? reauthError.message
          : "This OAuth account cannot be reauthenticated safely."
      );
    } finally {
      setReauthenticationLoadingId(null);
    }
  };

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading...</p>;
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
        Failed to load integrations: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header with add button */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {(() => { const total = integrationCredentials.length + oauthConnections.filter((c) => c.status === "active").length; return `${total} service${total !== 1 ? "s" : ""} connected`; })()}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => openPanel("integration-catalog")}
            className="rounded-md border border-border/40 px-2.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
          >
            Browse catalog
          </button>
          <button
            onClick={() => { setAddCredType(undefined); setShowAdd(true); }}
            className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add
          </button>
        </div>
      </div>

      {/* Connected integrations */}
      {integrationCredentials.length > 0 && (
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

      {/* Empty state when nothing connected at all */}
      {integrationCredentials.length === 0 && oauthConnections.filter((c) => c.status === "active").length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/50 p-6 text-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/30">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
          <div>
            <p className="text-xs font-medium text-muted-foreground">No services connected</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/60">
              Connect your services below to give your AI access
            </p>
          </div>
        </div>
      )}

      {/* Available native integrations */}
      {unconnectedNative.length > 0 && (
        <div>
          <p className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Available integrations
          </p>
          <div className="flex flex-wrap gap-1">
            {unconnectedNative.map((p) => (
              <button
                key={p.id}
                onClick={() => handleAddWithProvider(p.credentialType)}
                className="flex items-center gap-1.5 rounded-md border border-dashed border-border/40 px-2 py-1 text-[10px] text-muted-foreground/60 hover:border-primary/40 hover:text-primary/80 transition-all"
              >
                <ProviderIcon icon={p.icon} size={14} className="opacity-50" />
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {reauthenticationError && (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-[10px] text-destructive"
        >
          {reauthenticationError} Use the integration catalog to review the saved connection.
        </div>
      )}

      {/* Direct OAuth accounts (Google, Reddit — no third-party needed) */}
      {directOAuthProviders.length > 0 && (
        <div>
          <p className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Direct connect
          </p>
          <div className="flex flex-col gap-2">
            {directOAuthProviders.map((p) => {
              const candidates = oauthConnections.filter(
                (connection) => connection.method === "direct" && connection.platform === p.id
              );
              const reauthenticationCandidates = candidates.filter(connectionNeedsReauthentication);
              const exactReauthentication =
                candidates.length === 1 && reauthenticationCandidates.length === 1
                  ? reauthenticationCandidates[0]
                  : undefined;
              const providerNeedsReauthentication =
                (p as typeof p & { needsReauthentication?: boolean }).needsReauthentication ===
                true;
              const requiresManifestReauthentication =
                providerNeedsReauthentication || reauthenticationCandidates.length > 0;
              const canReauthenticate = !!exactReauthentication?.reauthenticationTarget;
              const actionLabel =
                candidates.length > 1
                  ? "Review accounts"
                  : canReauthenticate
                    ? "Reconnect"
                    : "Review in catalog";
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/5 p-3"
                >
                  <ProviderIcon icon={p.icon} size={18} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">{p.name}</p>
                    <p className="text-[9px] text-muted-foreground/60 line-clamp-1">
                      {p.description}
                    </p>
                  </div>
                  {requiresManifestReauthentication ? (
                    <button
                      type="button"
                      disabled={reauthenticationLoadingId === exactReauthentication?.id}
                      onClick={() => {
                        if (canReauthenticate && exactReauthentication) {
                          void handleReauthenticate(exactReauthentication);
                        } else {
                          openPanel("integration-catalog");
                        }
                      }}
                      className="rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                    >
                      {reauthenticationLoadingId === exactReauthentication?.id
                        ? "Loading…"
                        : actionLabel}
                    </button>
                  ) : (
                    <OAuthConnectButton
                      provider={p}
                      compact
                      onConnected={fetchOAuthState}
                      onSetupRequired={handleAddWithProvider}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Composio OAuth accounts (Twitter, LinkedIn, etc.) */}
      {composioOAuthProviders.length > 0 && (
        <div>
          <button
            onClick={() => setComposioExpanded(!composioExpanded)}
            className="flex items-center gap-1.5 mb-1.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            <svg
              width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${composioExpanded ? "rotate-90" : ""}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            More services via Composio
          </button>

          {composioExpanded && (
            <div className="flex flex-col gap-2">
              {/* Composio explainer */}
              {!hasComposioKey && (
                <div className="rounded-lg border border-border/40 bg-muted/5 p-3">
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">Composio</span> is a free OAuth bridge
                    that securely connects services like Twitter, LinkedIn, and Spotify.
                    You bring your own API key — tokens stay under your control.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <a
                      href="https://app.composio.dev/settings"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[9px] text-primary hover:underline"
                    >
                      Get a free key
                    </a>
                    <button
                      onClick={() => handleAddWithProvider("composio")}
                      className="rounded-md bg-primary/10 px-2 py-0.5 text-[9px] font-medium text-primary hover:bg-primary/20 transition-colors"
                    >
                      Add Composio API key
                    </button>
                  </div>
                </div>
              )}

              {/* Composio service grid */}
              <div className="flex flex-col gap-2">
                {composioOAuthProviders.map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-center gap-3 rounded-lg border border-border/50 bg-muted/5 p-3 ${!hasComposioKey ? "opacity-50" : ""}`}
                  >
                    <ProviderIcon icon={p.icon} size={18} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground">{p.name}</p>
                      <p className="text-[9px] text-muted-foreground/60 line-clamp-1">{p.description}</p>
                    </div>
                    {hasComposioKey ? (
                      <OAuthConnectButton
                        provider={p}
                        compact
                        onConnected={fetchOAuthState}
                      />
                    ) : (
                      <span className="text-[9px] text-muted-foreground/40">Needs Composio key</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add dialog */}
      {showAdd && (
        <AddCredentialDialog
          onClose={() => { setShowAdd(false); setAddCredType(undefined); fetchAll(); fetchOAuthState(); }}
          filter="integration"
          initialCredType={addCredType}
        />
      )}

      {/* Edit dialog */}
      {editingCredential && (
        <AddCredentialDialog
          onClose={() => { setEditingCredential(null); fetchAll(); }}
          editCredential={editingCredential}
        />
      )}

      {reauthenticationTarget && (
        <IntegrationSetupFlow
          manifest={reauthenticationTarget.manifest}
          credentialType={reauthenticationTarget.credentialType}
          manifestCredentialId={reauthenticationTarget.manifestCredentialId}
          mode="reauthenticate"
          targetCredentialId={reauthenticationTarget.targetCredentialId}
          oauthCredentialId={reauthenticationTarget.oauthCredentialId}
          onCompleted={() => {
            fetchAll();
            fetchOAuthState();
          }}
          onClose={() => {
            setReauthenticationTarget(null);
            fetchAll();
            fetchOAuthState();
          }}
        />
      )}
    </div>
  );
}
