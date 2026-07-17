import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IntegrationAuthStatus, OAuthProviderDef } from "@chvor/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useFeatureStore } from "../../stores/feature-store";

type Status = "idle" | "loading" | "polling" | "success" | "error" | "needs-setup";

export interface OAuthCompletion {
  connectionId: string;
  flowId?: string;
  credentialId?: string;
}

interface Props {
  provider: OAuthProviderDef & {
    connected?: boolean;
    hasSetupCredentials?: boolean;
    authStatus?: IntegrationAuthStatus;
    needsReauthentication?: boolean;
  };
  /** Durable manifest setup flow; callbacks and close fallback remain scoped to this exact flow. */
  flowId?: string;
  /** Snapshot revision at initiation, used to prove popup-close flow progression. */
  flowRevision?: number;
  /** Exact OAuth account identity, separate from the setup/app credential target. */
  oauthCredentialId?: string;
  onConnected?: (completion: OAuthCompletion) => void;
  onSetupRequired?: (credentialType: string) => void;
  compact?: boolean;
}

interface OAuthAttempt {
  connectionId: string;
  flowId?: string;
  flowRevision?: number;
  oauthCredentialId?: string;
  callbackOrigin: string;
  method: OAuthProviderDef["method"];
}

interface OAuthCallbackMessage {
  type?: unknown;
  success?: unknown;
  connectionId?: unknown;
  credentialId?: unknown;
  flowId?: unknown;
}

const NEW_ACCOUNT = "__new_oauth_account__";
const REAUTH_STATUSES = new Set<IntegrationAuthStatus>([
  "expired",
  "revoked",
  "reauthentication-required",
]);

function safeCallbackId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function safeCallbackOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function closePopupBestEffort(popup: Window | null) {
  if (!popup || popup === window || popup.closed) return;
  try {
    popup.close();
  } catch {
    // Popup teardown is best-effort.
  }
}

export function OAuthConnectButton({
  provider,
  flowId,
  flowRevision,
  oauthCredentialId,
  onConnected,
  onSetupRequired,
  compact,
}: Props) {
  const oauthConnections = useFeatureStore((state) => state.oauthConnections);
  const credentials = useFeatureStore((state) => state.credentials);
  const candidates = useMemo(
    () => oauthConnections.filter((candidate) => candidate.platform === provider.id),
    [oauthConnections, provider.id]
  );
  const candidateIdentity = useMemo(
    () =>
      candidates
        .map((candidate) => `${candidate.id}\u0000${candidate.credentialId ?? ""}`)
        .sort()
        .join("\u0001"),
    [candidates]
  );
  const [selectedAccount, setSelectedAccount] = useState("");
  const [appCredentialCandidateIds, setAppCredentialCandidateIds] = useState<string[]>([]);
  const [selectedAppCredentialId, setSelectedAppCredentialId] = useState("");
  const manifestBoundBroker = provider.method === "composio" && Boolean(flowId);
  const explicitlyNew = selectedAccount === NEW_ACCOUNT;
  const exactConnection = manifestBoundBroker
    ? undefined
    : oauthCredentialId
      ? candidates.find((candidate) => candidate.credentialId === oauthCredentialId)
      : selectedAccount && !explicitlyNew
        ? candidates.find((candidate) => candidate.id === selectedAccount)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
  const exactOAuthCredentialId = oauthCredentialId ?? exactConnection?.credentialId;
  const accountSelectionRequired =
    !manifestBoundBroker && !oauthCredentialId && candidates.length > 1 && selectedAccount === "";
  const appCredentialSelectionRequired =
    appCredentialCandidateIds.length > 0 && selectedAppCredentialId === "";
  const authStatus = manifestBoundBroker
    ? "unknown"
    : explicitlyNew
      ? "unknown"
      : exactConnection
        ? (exactConnection.authStatus ?? (exactConnection.status as IntegrationAuthStatus))
        : exactOAuthCredentialId
          ? provider.authStatus && REAUTH_STATUSES.has(provider.authStatus)
            ? provider.authStatus
            : "unknown"
          : (provider.authStatus ?? (provider.connected ? "active" : "unknown"));
  const requiresReauthentication = manifestBoundBroker
    ? false
    : explicitlyNew
      ? false
      : exactConnection
        ? exactConnection.needsReauthentication === true || REAUTH_STATUSES.has(authStatus)
        : provider.needsReauthentication === true || REAUTH_STATUSES.has(authStatus);
  const reauthenticationTarget =
    requiresReauthentication && provider.method === "direct" ? exactOAuthCredentialId : undefined;
  const [status, setStatus] = useState<Status>(
    !flowId && provider.connected && !requiresReauthentication ? "success" : "idle"
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const popupRef = useRef<Window | null>(null);
  const attemptRef = useRef<OAuthAttempt | null>(null);
  const completedFlowRef = useRef<string | null>(null);
  const onConnectedRef = useRef(onConnected);
  const statusRef = useRef<Status>(status);
  const mountedRef = useRef(false);
  const attemptGenerationRef = useRef(0);
  const attemptIdentity = `${provider.id}\u0000${provider.method}\u0000${flowId ?? ""}\u0000${oauthCredentialId ?? ""}\u0000${candidateIdentity}`;
  const previousAttemptIdentityRef = useRef(attemptIdentity);
  statusRef.current = status;
  onConnectedRef.current = onConnected;

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = undefined;
    timeoutRef.current = undefined;
  }, []);

  const invalidateActiveAttempt = useCallback(() => {
    attemptGenerationRef.current += 1;
    clearTimers();
    attemptRef.current = null;
    const popup = popupRef.current;
    popupRef.current = null;
    closePopupBestEffort(popup);
  }, [clearTimers]);

  useEffect(() => {
    if (statusRef.current === "loading" || statusRef.current === "polling") return;
    if (requiresReauthentication || accountSelectionRequired || explicitlyNew) {
      setStatus("idle");
    } else if (
      !flowId &&
      (exactConnection?.status === "active" || (!exactConnection && provider.connected))
    ) {
      setStatus("success");
    } else if (
      statusRef.current === "success" &&
      (!flowId || completedFlowRef.current !== flowId)
    ) {
      setStatus("idle");
    }
  }, [
    accountSelectionRequired,
    exactConnection,
    explicitlyNew,
    flowId,
    provider.connected,
    requiresReauthentication,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const handler = (event: MessageEvent<OAuthCallbackMessage>) => {
      const popup = popupRef.current;
      const attempt = attemptRef.current;
      const message = event.data;
      if (!popup || !attempt || event.origin !== attempt.callbackOrigin || event.source !== popup)
        return;
      if (message?.type !== "chvor-oauth-callback") return;
      if (message.connectionId !== attempt.connectionId) return;
      if (attempt.flowId !== undefined && message.flowId !== attempt.flowId) return;

      const callbackCredentialId = safeCallbackId(message.credentialId);
      if (message.success === true && attempt.method === "direct" && !callbackCredentialId) return;
      if (attempt.oauthCredentialId && callbackCredentialId !== attempt.oauthCredentialId) {
        return;
      }

      clearTimers();
      attemptGenerationRef.current += 1;
      attemptRef.current = null;
      if (message.success === true) closePopupBestEffort(popup);
      popupRef.current = null;
      if (message.success === true) {
        completedFlowRef.current = attempt.flowId ?? null;
        setStatus("success");
        void useFeatureStore.getState().fetchOAuthState();
        onConnectedRef.current?.({
          connectionId: attempt.connectionId,
          ...(attempt.flowId ? { flowId: attempt.flowId } : {}),
          ...(callbackCredentialId ? { credentialId: callbackCredentialId } : {}),
        });
      } else {
        setStatus("error");
        setErrorMsg("OAuth was not completed.");
      }
    };
    window.addEventListener("message", handler);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("message", handler);
      invalidateActiveAttempt();
    };
  }, [clearTimers, invalidateActiveAttempt]);

  useEffect(() => {
    if (previousAttemptIdentityRef.current === attemptIdentity) return;
    previousAttemptIdentityRef.current = attemptIdentity;
    invalidateActiveAttempt();
    completedFlowRef.current = null;
    setSelectedAccount("");
    setAppCredentialCandidateIds([]);
    setSelectedAppCredentialId("");
    setErrorMsg(null);
    setStatus("idle");
  }, [attemptIdentity, invalidateActiveAttempt]);

  const handleConnect = useCallback(async () => {
    if (requiresReauthentication && !flowId) {
      setStatus("error");
      setErrorMsg("Reauthentication must be started from the integration catalog.");
      return;
    }
    if (
      accountSelectionRequired ||
      appCredentialSelectionRequired ||
      (requiresReauthentication && !reauthenticationTarget)
    ) {
      return;
    }
    invalidateActiveAttempt();
    const attemptGeneration = attemptGenerationRef.current;
    completedFlowRef.current = null;
    setStatus("loading");
    setErrorMsg(null);

    try {
      const result = await api.oauth.initiate(provider.id, {
        ...(flowId ? { flowId } : {}),
        ...(reauthenticationTarget ? { oauthCredentialId: reauthenticationTarget } : {}),
        ...(selectedAppCredentialId ? { appCredentialId: selectedAppCredentialId } : {}),
      });
      if (!mountedRef.current || attemptGenerationRef.current !== attemptGeneration) return;
      if (flowId && result.flowId !== flowId) {
        setStatus("error");
        setErrorMsg("OAuth provider did not retain this durable setup flow.");
        return;
      }
      if (
        reauthenticationTarget &&
        result.oauthCredentialId &&
        result.oauthCredentialId !== reauthenticationTarget
      ) {
        setStatus("error");
        setErrorMsg("OAuth provider returned a different account target.");
        return;
      }
      const callbackOrigin = safeCallbackOrigin(result.callbackOrigin);
      if (!callbackOrigin) {
        setStatus("error");
        setErrorMsg("OAuth provider returned an invalid callback origin.");
        return;
      }
      const popup = window.open(result.redirectUrl, "_blank", "width=600,height=700");
      if (!popup) {
        setStatus("error");
        setErrorMsg("The OAuth popup was blocked. Allow popups and try again.");
        return;
      }
      if (!mountedRef.current || attemptGenerationRef.current !== attemptGeneration) {
        if (popup !== window && !popup.closed) popup.close();
        return;
      }
      popupRef.current = popup;
      const attempt: OAuthAttempt = {
        connectionId: result.connectionId,
        method: provider.method,
        callbackOrigin,
        ...((result.flowId ?? flowId) ? { flowId: result.flowId ?? flowId } : {}),
        ...(flowRevision !== undefined ? { flowRevision } : {}),
        ...((result.oauthCredentialId ?? reauthenticationTarget)
          ? { oauthCredentialId: result.oauthCredentialId ?? reauthenticationTarget }
          : {}),
      };
      attemptRef.current = attempt;
      setStatus("polling");

      pollRef.current = setInterval(() => {
        if (
          !mountedRef.current ||
          attemptGenerationRef.current !== attemptGeneration ||
          attemptRef.current !== attempt
        ) {
          return;
        }
        if (!popup.closed) return;
        clearTimers();
        timeoutRef.current = setTimeout(async () => {
          if (
            !mountedRef.current ||
            attemptGenerationRef.current !== attemptGeneration ||
            attemptRef.current !== attempt
          ) {
            return;
          }
          let verified = false;
          try {
            await useFeatureStore.getState().fetchOAuthState();
            if (
              !mountedRef.current ||
              attemptGenerationRef.current !== attemptGeneration ||
              attemptRef.current !== attempt
            ) {
              return;
            }
            if (attempt.flowId) {
              const exactFlow = await api.integrationSetup.get(attempt.flowId);
              if (
                !mountedRef.current ||
                attemptGenerationRef.current !== attemptGeneration ||
                attemptRef.current !== attempt
              ) {
                return;
              }
              const completedOAuthCredentialId = safeCallbackId(exactFlow.oauthCredentialId);
              const revisionAdvanced =
                attempt.flowRevision === undefined || exactFlow.revision > attempt.flowRevision;
              const directCompletion =
                attempt.method !== "direct" ||
                (completedOAuthCredentialId !== undefined &&
                  (attempt.oauthCredentialId === undefined ||
                    completedOAuthCredentialId === attempt.oauthCredentialId));
              const exactCompletion =
                exactFlow.id === attempt.flowId &&
                exactFlow.authStatus === "active" &&
                exactFlow.status !== "awaiting-oauth" &&
                exactFlow.status !== "failed" &&
                exactFlow.status !== "cancelled" &&
                exactFlow.status !== "expired" &&
                revisionAdvanced &&
                directCompletion;
              if (exactCompletion) {
                verified = true;
                completedFlowRef.current = attempt.flowId;
                setStatus("success");
                onConnectedRef.current?.({
                  connectionId: attempt.connectionId,
                  flowId: attempt.flowId,
                  ...(completedOAuthCredentialId
                    ? { credentialId: completedOAuthCredentialId }
                    : {}),
                });
                return;
              }
            }
          } catch {
            // A failed verification never falls back to an arbitrary active OAuth account.
          } finally {
            const attemptIsCurrent =
              mountedRef.current &&
              attemptGenerationRef.current === attemptGeneration &&
              attemptRef.current === attempt;
            if (attemptIsCurrent) {
              attemptRef.current = null;
              if (popupRef.current === popup) popupRef.current = null;
              if (!verified && statusRef.current === "polling") {
                setStatus("idle");
              }
            }
          }
        }, 1500);
      }, 1000);
    } catch (error: unknown) {
      if (!mountedRef.current || attemptGenerationRef.current !== attemptGeneration) return;
      const setupError = error as {
        needsSetup?: boolean;
        setupCredentialType?: string;
        code?: string;
        candidateCredentialIds?: string[];
        message?: string;
      };
      if (
        setupError.code === "oauth_app_credential_selection_required" &&
        Array.isArray(setupError.candidateCredentialIds) &&
        setupError.candidateCredentialIds.length > 0
      ) {
        const candidateIds = Array.from(new Set(setupError.candidateCredentialIds));
        setAppCredentialCandidateIds(candidateIds);
        setSelectedAppCredentialId((current) => (candidateIds.includes(current) ? current : ""));
        setStatus("error");
        setErrorMsg(setupError.message ?? "Choose the OAuth app credentials to use.");
      } else if (setupError.needsSetup && setupError.setupCredentialType) {
        setStatus("needs-setup");
        onSetupRequired?.(setupError.setupCredentialType);
      } else {
        setStatus("error");
        setErrorMsg(setupError.message ?? "OAuth could not be started.");
      }
    }
  }, [
    accountSelectionRequired,
    appCredentialSelectionRequired,
    clearTimers,
    flowId,
    flowRevision,
    invalidateActiveAttempt,
    onSetupRequired,
    provider.id,
    provider.method,
    reauthenticationTarget,
    requiresReauthentication,
    selectedAppCredentialId,
  ]);

  const handleDisconnect = useCallback(async () => {
    if (!exactConnection) return;
    try {
      await api.oauth.disconnect(exactConnection.id);
      setStatus("idle");
      void useFeatureStore.getState().fetchOAuthState();
    } catch (error) {
      setStatus("error");
      setErrorMsg(error instanceof Error ? error.message : "Disconnect failed");
    }
  }, [exactConnection]);

  const accountPicker = !manifestBoundBroker && candidates.length > 1 && !oauthCredentialId && (
    <select
      aria-label={`OAuth account for ${provider.name}`}
      value={selectedAccount}
      onChange={(event) => {
        setSelectedAccount(event.target.value);
        setAppCredentialCandidateIds([]);
        setSelectedAppCredentialId("");
        setStatus("idle");
        setErrorMsg(null);
      }}
      disabled={status === "loading" || status === "polling"}
      className="max-w-48 rounded-md border border-border/50 bg-background/40 px-2 py-1 text-[9px]"
    >
      <option value="">Choose an account…</option>
      {candidates.map((candidate) => {
        return (
          <option key={candidate.id} value={candidate.id}>
            {candidate.credentialId ?? candidate.id} — {candidate.authStatus ?? candidate.status}
          </option>
        );
      })}
      <option value={NEW_ACCOUNT}>Connect another account</option>
    </select>
  );

  const appCredentialPicker = appCredentialCandidateIds.length > 0 && (
    <label className="flex max-w-64 flex-col gap-1 text-[9px] text-muted-foreground">
      <span>OAuth app credentials</span>
      <select
        aria-label={`OAuth app credentials for ${provider.name}`}
        value={selectedAppCredentialId}
        onChange={(event) => {
          setSelectedAppCredentialId(event.target.value);
          setStatus("idle");
          setErrorMsg(null);
        }}
        disabled={status === "loading" || status === "polling"}
        required
        aria-required="true"
        className="rounded-md border border-border/50 bg-background/40 px-2 py-1 text-[9px] text-foreground"
      >
        <option value="">Choose app credentials…</option>
        {appCredentialCandidateIds.map((candidateId) => {
          const credential = credentials.find((item) => item.id === candidateId);
          return (
            <option key={candidateId} value={candidateId}>
              {credential?.name ? `${credential.name} — ${candidateId}` : candidateId}
            </option>
          );
        })}
      </select>
    </label>
  );

  const connected =
    !flowId &&
    !accountSelectionRequired &&
    appCredentialCandidateIds.length === 0 &&
    (status === "success" || authStatus === "active") &&
    !requiresReauthentication;
  if (flowId && status === "success") {
    return (
      <span role="status" className="text-[10px] text-emerald-500">
        Authorized. Continuing setup…
      </span>
    );
  }
  if (connected) {
    return (
      <div className={cn("flex items-center gap-2", compact && "gap-1.5")}>
        {accountPicker}
        <span className="flex items-center gap-1 text-[10px] text-green-500">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Connected
        </span>
        {provider.method === "composio" && (
          <span className="text-[8px] text-muted-foreground/40">via Composio</span>
        )}
        {exactConnection && (
          <button
            type="button"
            onClick={handleDisconnect}
            className="text-[9px] text-muted-foreground/50 transition-colors hover:text-destructive"
          >
            Disconnect
          </button>
        )}
      </div>
    );
  }

  if (status === "needs-setup") {
    return (
      <button
        type="button"
        onClick={() => onSetupRequired?.(provider.setupCredentialType ?? "")}
        className={cn(
          "rounded-md bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-500 transition-colors hover:bg-amber-500/20",
          compact && "px-2 py-0.5 text-[9px]"
        )}
      >
        Setup required
      </button>
    );
  }

  const targetRequired = requiresReauthentication && !reauthenticationTarget;
  return (
    <div className="flex flex-col items-start gap-1">
      {accountPicker}
      {appCredentialPicker}
      <button
        type="button"
        onClick={handleConnect}
        disabled={
          status === "loading" ||
          status === "polling" ||
          accountSelectionRequired ||
          appCredentialSelectionRequired ||
          targetRequired
        }
        className={cn(
          "rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50",
          compact && "px-2 py-0.5 text-[9px]",
          requiresReauthentication && "bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
        )}
      >
        {status === "loading"
          ? "Starting…"
          : status === "polling"
            ? "Waiting…"
            : accountSelectionRequired
              ? "Choose account"
              : appCredentialSelectionRequired
                ? "Choose app credentials"
                : targetRequired
                  ? "Account unavailable"
                  : requiresReauthentication
                    ? "Reauthenticate"
                    : manifestBoundBroker
                      ? "Connect new account"
                      : "Connect"}
      </button>
      {provider.method === "composio" && status === "idle" && !requiresReauthentication && (
        <span className="text-[8px] text-muted-foreground/40">
          {manifestBoundBroker ? "Creates a new account connection via Composio" : "via Composio"}
        </span>
      )}
      {requiresReauthentication && status === "idle" && (
        <span className="text-[9px] text-amber-500">Authorization expired. Connect again.</span>
      )}
      {status === "error" && errorMsg && (
        <span role="alert" className="text-[9px] text-destructive">
          {errorMsg}
        </span>
      )}
    </div>
  );
}
