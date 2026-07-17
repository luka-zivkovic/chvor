import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IntegrationManifest,
  IntegrationSetupDuplicateDecisionRequest,
  IntegrationSetupFlowSnapshot,
  IntegrationSetupMode,
} from "@chvor/shared";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  OAuthConnectButton,
  type OAuthCompletion,
} from "@/components/credentials/OAuthConnectButton";
import {
  acknowledgeIntegrationInstruction,
  canAcknowledgeIntegrationInstruction,
} from "./integration-setup-continuation";
import {
  flowOAuthCredentialId,
  integrationSetupResumeKey,
  setupFlowMatchesIdentity,
  type IntegrationSetupIdentity,
} from "./integration-setup-resume";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
const START_IDEMPOTENCY_KEY_PATTERN =
  /^setup-start:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Props {
  manifest: IntegrationManifest;
  credentialType: string;
  manifestCredentialId?: string;
  mode?: IntegrationSetupMode;
  /** Setup/app credential target; distinct from the OAuth account target. */
  targetCredentialId?: string;
  /** Exact OAuth account target when reauthorizing an existing account. */
  oauthCredentialId?: string;
  initialFlowId?: string;
  onClose: () => void;
  onCompleted?: () => void;
}

type ActionError = Error & {
  status?: number;
  code?: string;
  expectedRevision?: number;
};

function safeStorageGet(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function safeStorageSet(key: string, flowId: string): void {
  try {
    window.localStorage.setItem(key, flowId);
  } catch {
    // Resuming is best-effort when storage is unavailable.
  }
}

function safeStorageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing sensitive is retained when storage is unavailable.
  }
}

function createStartIdempotencyKey(): string {
  return `setup-start:${window.crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Setup could not be updated.";
  const code = (error as ActionError).code;
  return code ? `${code}: ${error.message}` : error.message;
}

function staleStoredFlow(error: unknown): boolean {
  const candidate = error as ActionError;
  return (
    candidate.status === 404 ||
    candidate.code === "integration_setup_flow_not_found" ||
    candidate.code === "integration_setup_flow_expired"
  );
}

function statusLabel(status: IntegrationSetupFlowSnapshot["status"]): string {
  return status.replaceAll("-", " ");
}

export function IntegrationSetupFlow({
  manifest,
  credentialType,
  manifestCredentialId,
  mode = "setup",
  targetCredentialId,
  oauthCredentialId,
  initialFlowId,
  onClose,
  onCompleted,
}: Props) {
  const identity = useMemo<IntegrationSetupIdentity>(
    () => ({
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      ...(manifestCredentialId ? { manifestCredentialId } : {}),
      credentialType,
      mode,
      ...(targetCredentialId ? { setupTargetCredentialId: targetCredentialId } : {}),
      ...(oauthCredentialId ? { oauthCredentialId } : {}),
    }),
    [
      credentialType,
      manifest.id,
      manifest.version,
      manifestCredentialId,
      mode,
      oauthCredentialId,
      targetCredentialId,
    ]
  );
  const key = useMemo(() => integrationSetupResumeKey(identity), [identity]);
  const startAttemptKey = useMemo(() => `${key}:start`, [key]);
  const [flow, setFlow] = useState<IntegrationSetupFlowSnapshot | null>(null);
  const [resolvedOAuthCredentialId, setResolvedOAuthCredentialId] = useState(oauthCredentialId);
  const [credentialData, setCredentialData] = useState<Record<string, string>>({});
  const [duplicateChoice, setDuplicateChoice] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const completionRef = useRef<string | null>(null);
  const discoveryAttemptRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const focusedStepRef = useRef<string | null>(null);
  const acceptedFlowRef = useRef<IntegrationSetupFlowSnapshot | null>(null);
  const startAttemptRef = useRef<{ storageKey: string; idempotencyKey: string } | null>(null);

  const duplicateChoiceContext = flow
    ? `${flow.id}:${flow.revision}:${flow.currentStepId ?? "terminal"}:${flow.duplicateCandidates.map((candidate) => `${candidate.id}:${candidate.allowedDecisions.join("+")}`).join(",")}`
    : "";

  useEffect(() => {
    setDuplicateChoice("");
  }, [duplicateChoiceContext]);

  const applyFlow = useCallback(
    (next: IntegrationSetupFlowSnapshot, replace = false): boolean => {
      if (!setupFlowMatchesIdentity(next, identity)) {
        throw new Error("Setup flow identity does not match this integration request.");
      }

      const current = acceptedFlowRef.current;
      if (current && current.id !== next.id && !replace) return false;
      if (current?.id === next.id) {
        if (TERMINAL_STATUSES.has(current.status)) return false;
        if (next.revision < current.revision) return false;
        if (
          next.revision === current.revision &&
          !TERMINAL_STATUSES.has(next.status) &&
          JSON.stringify(next) === JSON.stringify(current)
        ) {
          return false;
        }
      }

      const replacesCurrent = current !== null && current.id !== next.id;
      acceptedFlowRef.current = next;
      setFlow(next);
      safeStorageRemove(startAttemptKey);
      if (startAttemptRef.current?.storageKey === startAttemptKey) {
        startAttemptRef.current = null;
      }
      const nextOAuthCredentialId = flowOAuthCredentialId(next);
      if (replacesCurrent) {
        setCredentialData({});
        setResolvedOAuthCredentialId(nextOAuthCredentialId ?? oauthCredentialId);
      } else if (nextOAuthCredentialId) {
        setResolvedOAuthCredentialId(nextOAuthCredentialId);
      }
      if (TERMINAL_STATUSES.has(next.status)) safeStorageRemove(key);
      else safeStorageSet(key, next.id);
      if (next.status === "completed" || next.status === "cancelled") setCredentialData({});
      return true;
    },
    [identity, key, oauthCredentialId, startAttemptKey]
  );

  const loadFlow = useCallback(
    async (flowId: string) => {
      const next = await api.integrationSetup.get(flowId);
      applyFlow(next);
      return next;
    },
    [applyFlow]
  );

  const requestStartFlow = useCallback(async () => {
    const inMemoryAttempt = startAttemptRef.current;
    const storedAttempt = safeStorageGet(startAttemptKey);
    const idempotencyKey =
      (inMemoryAttempt?.storageKey === startAttemptKey
        ? inMemoryAttempt.idempotencyKey
        : undefined) ??
      (storedAttempt && START_IDEMPOTENCY_KEY_PATTERN.test(storedAttempt)
        ? storedAttempt
        : createStartIdempotencyKey());
    startAttemptRef.current = { storageKey: startAttemptKey, idempotencyKey };
    safeStorageSet(startAttemptKey, idempotencyKey);
    return api.integrationSetup.start({
      schemaVersion: 1,
      idempotencyKey,
      integrationId: manifest.id,
      manifestVersion: manifest.version,
      ...(manifestCredentialId ? { manifestCredentialId } : {}),
      ...(targetCredentialId ? { targetCredentialId } : {}),
      ...(oauthCredentialId ? { oauthCredentialId } : {}),
      credentialType,
      mode,
    });
  }, [
    credentialType,
    manifest.id,
    manifest.version,
    manifestCredentialId,
    mode,
    oauthCredentialId,
    startAttemptKey,
    targetCredentialId,
  ]);

  const startFlow = useCallback(async () => {
    const next = await requestStartFlow();
    applyFlow(next, true);
    return next;
  }, [applyFlow, requestStartFlow]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setActionError(null);
    const storedFlowId = initialFlowId ?? safeStorageGet(key);

    const boot = async () => {
      try {
        if (storedFlowId) {
          try {
            const resumed = await api.integrationSetup.get(storedFlowId);
            if (setupFlowMatchesIdentity(resumed, identity)) {
              if (!disposed) applyFlow(resumed, true);
              return;
            }
            if (initialFlowId) {
              throw new Error("Requested setup flow belongs to a different integration setup.");
            }
            safeStorageRemove(key);
          } catch (error) {
            if (initialFlowId || !staleStoredFlow(error)) throw error;
            safeStorageRemove(key);
          }
        }
        const started = await requestStartFlow();
        if (!disposed) applyFlow(started, true);
      } catch (error) {
        if (!disposed) setActionError(errorMessage(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void boot();
    return () => {
      disposed = true;
    };
  }, [applyFlow, initialFlowId, identity, key, requestStartFlow]);

  useEffect(() => {
    if (!flow || flow.status !== "awaiting-oauth") return;
    const timer = window.setInterval(() => {
      void loadFlow(flow.id)
        .then(() => setActionError(null))
        .catch((error) => {
          setActionError(errorMessage(error));
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [flow, loadFlow]);

  useEffect(() => {
    if (flow?.status !== "completed" || completionRef.current === flow.id) return;
    completionRef.current = flow.id;
    onCompleted?.();
  }, [flow, onCompleted]);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const previous = restoreFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const focusKey = loading
      ? "loading"
      : `${flow?.id ?? "no-flow"}:${flow?.currentStepId ?? "terminal"}:${flow?.status ?? "error"}`;
    if (focusedStepRef.current === focusKey) return;
    focusedStepRef.current = focusKey;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (loading) {
        dialog.focus();
        return;
      }
      const target = dialog.querySelector<HTMLElement>(
        "[data-setup-step] input:not([disabled]), [data-setup-step] button:not([disabled]), [data-setup-step] select:not([disabled]), [data-setup-step] textarea:not([disabled]), [data-setup-focus-status], footer button:not([disabled])"
      );
      (target ?? dialog).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flow?.currentStepId, flow?.id, flow?.status, loading]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting && !loading) {
        event.preventDefault();
        setCredentialData({});
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [loading, onClose, submitting]);

  const recoverConflict = useCallback(
    async (error: unknown): Promise<boolean> => {
      const candidate = error as ActionError;
      if (!flow || (candidate.status !== 409 && candidate.expectedRevision === undefined)) {
        return false;
      }
      try {
        await loadFlow(flow.id);
        setNotice("Setup changed elsewhere. Latest progress loaded.");
      } catch (refreshError) {
        setActionError(errorMessage(refreshError));
      }
      return true;
    },
    [flow, loadFlow]
  );

  useEffect(() => {
    const step = flow?.steps.find((candidate) => candidate.id === flow.currentStepId);
    if (
      !flow ||
      flow.status !== "discovering" ||
      flow.authStatus !== "active" ||
      step?.kind !== "diagnostic"
    ) {
      return;
    }
    const attemptKey = `${flow.id}:${flow.revision}:${step.id}`;
    if (discoveryAttemptRef.current === attemptKey) return;
    discoveryAttemptRef.current = attemptKey;
    let disposed = false;
    let retryTimer: number | undefined;

    const continueDiscovery = async () => {
      try {
        const next = await api.integrationSetup.discovery(flow.id, {
          schemaVersion: 1,
          flowId: flow.id,
          revision: flow.revision,
          stepId: step.id,
        });
        if (!disposed) {
          setActionError(null);
          applyFlow(next);
        }
      } catch (error) {
        if (disposed) return;
        if (!(await recoverConflict(error))) setActionError(errorMessage(error));
        discoveryAttemptRef.current = null;
        retryTimer = window.setTimeout(() => setDiscoveryRetry((value) => value + 1), 1500);
      }
    };
    void continueDiscovery();
    return () => {
      disposed = true;
      if (discoveryAttemptRef.current === attemptKey) discoveryAttemptRef.current = null;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [applyFlow, discoveryRetry, flow, recoverConflict]);

  const runAction = useCallback(
    async (action: () => Promise<IntegrationSetupFlowSnapshot>, clearSecrets = false) => {
      setSubmitting(true);
      setActionError(null);
      setNotice(null);
      try {
        const next = await action();
        applyFlow(next);
        if (clearSecrets) setCredentialData({});
      } catch (error) {
        if (!(await recoverConflict(error))) setActionError(errorMessage(error));
      } finally {
        setSubmitting(false);
      }
    },
    [applyFlow, recoverConflict]
  );

  const currentProgress = flow?.steps.find((step) => step.id === flow.currentStepId);
  const currentDeclaration = manifest.setup.find((step) => step.id === flow?.currentStepId);
  const credentialDeclarationId =
    currentDeclaration?.kind === "credential"
      ? currentDeclaration.credentialId
      : (flow?.manifestCredentialId ?? manifestCredentialId);
  const credential = manifest.credentials.find((item) => item.id === credentialDeclarationId);
  const oauthDeclaration =
    currentDeclaration?.kind === "oauth"
      ? manifest.oauth.find((item) => item.id === currentDeclaration.oauthId)
      : undefined;
  const oauthProviderId =
    oauthDeclaration && "provider" in oauthDeclaration ? oauthDeclaration.provider : undefined;
  const exactOAuthCredentialId =
    (flow ? flowOAuthCredentialId(flow) : undefined) ??
    resolvedOAuthCredentialId ??
    oauthCredentialId;
  const duplicateChoiceValid =
    duplicateChoice === "create-additional" ||
    flow?.duplicateCandidates.some((candidate) => {
      const [decision, credentialId] = duplicateChoice?.split(":") ?? [];
      return (
        credentialId === candidate.id &&
        (decision === "reuse-existing" || decision === "replace-existing") &&
        candidate.allowedDecisions.includes(decision)
      );
    }) === true;

  const credentialFieldValue = (field: NonNullable<typeof credential>["fields"][number]) => {
    const entered = credentialData[field.id];
    if (entered !== undefined) return entered;
    return mode === "setup" && "default" in field && typeof field.default === "string"
      ? field.default
      : "";
  };

  const requiredComplete =
    mode !== "setup" ||
    (credential?.fields
      .filter((field) => field.required)
      .every((field) => credentialFieldValue(field).trim().length > 0) ??
      false);

  const submitCredentials = () => {
    if (!flow || !currentProgress || !credential || !requiredComplete) return;
    const data = Object.fromEntries(
      credential.fields.flatMap((field) => {
        const value = credentialFieldValue(field);
        if (value.trim().length === 0) return [];
        return [[field.id, field.sensitivity === "secret" ? value : value.trim()] as const];
      })
    );
    void runAction(
      () =>
        api.integrationSetup.submitCredentials(flow.id, {
          schemaVersion: 1,
          flowId: flow.id,
          revision: flow.revision,
          stepId: currentProgress.id,
          data,
        }),
      true
    );
  };

  const confirmDuplicate = () => {
    if (!flow || !duplicateChoiceValid) return;
    let request: IntegrationSetupDuplicateDecisionRequest;
    if (duplicateChoice === "create-additional") {
      request = {
        schemaVersion: 1,
        flowId: flow.id,
        revision: flow.revision,
        decision: "create-additional",
      };
    } else if (
      duplicateChoice.startsWith("reuse-existing:") ||
      duplicateChoice.startsWith("replace-existing:")
    ) {
      const decision = duplicateChoice.startsWith("reuse-existing:")
        ? "reuse-existing"
        : "replace-existing";
      const credentialId = duplicateChoice.slice(`${decision}:`.length);
      if (!credentialId) return;
      request = {
        schemaVersion: 1,
        flowId: flow.id,
        revision: flow.revision,
        decision,
        credentialId,
      };
    } else return;
    void runAction(() => api.integrationSetup.confirm(flow.id, request));
  };

  const continueInstruction = () => {
    if (!flow) return;
    const continuation = acknowledgeIntegrationInstruction(flow);
    if (continuation) void runAction(() => continuation);
  };

  const handleOAuthConnected = (completion: OAuthCompletion) => {
    if (!flow || completion.flowId !== flow.id) return;
    if (exactOAuthCredentialId && completion.credentialId !== exactOAuthCredentialId) {
      return;
    }
    if (completion.credentialId) setResolvedOAuthCredentialId(completion.credentialId);
    void loadFlow(flow.id).catch((error) => setActionError(errorMessage(error)));
  };

  const cancel = async () => {
    if (!flow) {
      setCredentialData({});
      onClose();
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      const next = await api.integrationSetup.cancel(flow.id, flow.revision);
      applyFlow(next);
      setCredentialData({});
      onClose();
    } catch (error) {
      if (!(await recoverConflict(error))) setActionError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (loading || submitting) return;
    setCredentialData({});
    onClose();
  };

  const retryBoot = async () => {
    setLoading(true);
    setActionError(null);
    try {
      const resumableId = initialFlowId ?? safeStorageGet(key);
      if (resumableId) {
        try {
          const resumed = await api.integrationSetup.get(resumableId);
          applyFlow(resumed, true);
        } catch (error) {
          if (initialFlowId || !staleStoredFlow(error)) throw error;
          safeStorageRemove(key);
          await startFlow();
        }
      } else await startFlow();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-setup-title"
        tabIndex={-1}
        className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card p-5 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[9px] font-medium uppercase tracking-widest text-muted-foreground">
              {mode === "reauthenticate"
                ? "Reauthenticate"
                : mode === "reconfigure"
                  ? "Reconfigure"
                  : "Connect"}
            </p>
            <h2 id="integration-setup-title" className="mt-0.5 text-sm font-semibold">
              {manifest.name}
            </h2>
            <p className="mt-1 text-[10px] text-muted-foreground">{manifest.description}</p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={submitting || loading}
            aria-label="Close setup"
            className="rounded p-1 text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-40"
          >
            ×
          </button>
        </header>

        <div data-setup-step className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {loading && <p className="text-xs text-muted-foreground">Loading setup…</p>}

          {!loading && !flow && actionError && (
            <div role="alert" className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
              {actionError}
              <button type="button" onClick={() => void retryBoot()} className="ml-2 underline">
                Retry
              </button>
            </div>
          )}

          {flow && (
            <>
              <div className="flex items-center justify-between gap-2 rounded-md bg-muted/20 px-3 py-2">
                <span className="text-[10px] text-muted-foreground">Setup progress</span>
                <span className="text-[10px] font-medium capitalize">
                  {statusLabel(flow.status)}
                </span>
              </div>

              <ol aria-label="Setup progress" className="space-y-1.5">
                {flow.steps.map((step) => {
                  const declaration = manifest.setup.find((item) => item.id === step.id);
                  return (
                    <li
                      key={step.id}
                      aria-current={step.status === "active" ? "step" : undefined}
                      className="flex items-center gap-2 text-[10px]"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          step.status === "completed" && "bg-emerald-500",
                          step.status === "active" && "bg-primary",
                          step.status === "failed" && "bg-destructive",
                          step.status === "pending" && "bg-muted-foreground/30"
                        )}
                      />
                      <span
                        className={
                          step.status === "active" ? "text-foreground" : "text-muted-foreground"
                        }
                      >
                        {declaration?.title ?? step.id}
                        <span className="sr-only">
                          {" "}
                          — Status: {step.status.replaceAll("-", " ")}
                        </span>
                      </span>
                      {step.failureCode && (
                        <code className="text-destructive">{step.failureCode}</code>
                      )}
                    </li>
                  );
                })}
              </ol>

              {currentDeclaration?.kind === "instruction" && (
                <div className="rounded-md border border-border/50 bg-muted/10 p-3">
                  <h3 className="text-xs font-medium">{currentDeclaration.title}</h3>
                  <p className="mt-1 whitespace-pre-wrap text-[10px] text-muted-foreground">
                    {currentDeclaration.instructions}
                  </p>
                  {canAcknowledgeIntegrationInstruction() && (
                    <button
                      type="button"
                      onClick={continueInstruction}
                      disabled={submitting}
                      className="mt-3 rounded-md bg-primary/15 px-3 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                    >
                      Continue
                    </button>
                  )}
                </div>
              )}

              {flow.status === "awaiting-input" &&
                credential &&
                currentProgress?.kind === "credential" && (
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitCredentials();
                    }}
                  >
                    <div>
                      <h3 className="text-xs font-medium">{credential.name}</h3>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {credential.description}
                      </p>
                      {mode !== "setup" && (
                        <p className="mt-1 text-[10px] text-amber-500">
                          Leave stored fields blank to keep their existing values.
                        </p>
                      )}
                    </div>
                    {credential.fields.map((field) => (
                      <label key={field.id} className="block space-y-1 text-[10px] font-medium">
                        <span>
                          {field.label}
                          {!field.required && (
                            <span className="ml-1 text-muted-foreground">(optional)</span>
                          )}
                        </span>
                        <input
                          aria-label={field.label}
                          type={
                            field.sensitivity === "secret"
                              ? "password"
                              : field.sensitivity === "url"
                                ? "url"
                                : "text"
                          }
                          autoComplete={field.sensitivity === "secret" ? "new-password" : "off"}
                          required={mode === "setup" && field.required}
                          aria-required={mode === "setup" && field.required}
                          placeholder={
                            mode === "setup" ? undefined : "Leave blank to keep existing"
                          }
                          value={credentialFieldValue(field)}
                          onChange={(event) =>
                            setCredentialData((current) => ({
                              ...current,
                              [field.id]: event.target.value,
                            }))
                          }
                          className="w-full rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 font-mono text-xs focus:border-primary/50 focus:outline-none"
                        />
                        <span className="block font-normal text-muted-foreground">
                          {field.description}
                        </span>
                      </label>
                    ))}
                    <button
                      type="submit"
                      disabled={submitting || !requiredComplete}
                      className="rounded-md bg-primary/15 px-3 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                    >
                      {submitting
                        ? "Saving…"
                        : mode === "reauthenticate"
                          ? "Save and reauthenticate"
                          : "Save and continue"}
                    </button>
                  </form>
                )}

              {flow.status === "awaiting-confirmation" && (
                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium">
                    Choose how to handle the existing account
                  </legend>
                  <p className="text-[10px] text-muted-foreground">
                    A matching credential already exists. Select exactly one option before
                    continuing.
                  </p>
                  {flow.duplicateCandidates.flatMap((candidate) =>
                    candidate.allowedDecisions.map((decision) => (
                      <DuplicateOption
                        key={`${decision}:${candidate.id}`}
                        value={`${decision}:${candidate.id}`}
                        checked={duplicateChoice === `${decision}:${candidate.id}`}
                        onChange={setDuplicateChoice}
                        label={`${decision === "reuse-existing" ? "Reuse existing" : "Replace existing"} — ${candidate.accountLabel ?? candidate.name}`}
                      />
                    ))
                  )}
                  <DuplicateOption
                    value="create-additional"
                    checked={duplicateChoice === "create-additional"}
                    onChange={setDuplicateChoice}
                    label="Create a separate credential"
                  />
                  <button
                    type="button"
                    onClick={confirmDuplicate}
                    disabled={submitting || !duplicateChoiceValid}
                    className="rounded-md bg-primary/15 px-3 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                  >
                    Confirm choice
                  </button>
                </fieldset>
              )}

              {flow.status === "awaiting-oauth" && oauthDeclaration && oauthProviderId && (
                <div className="rounded-md border border-border/50 p-3">
                  <p className="mb-2 text-[10px] text-muted-foreground">
                    Complete authorization in the provider popup. This setup will resume
                    automatically.
                  </p>
                  <OAuthConnectButton
                    provider={{
                      id: oauthProviderId,
                      name: manifest.name,
                      icon: manifest.id,
                      method: oauthDeclaration.mode === "broker" ? "composio" : "direct",
                      category: "developer",
                      description: manifest.description,
                      connected: false,
                      authStatus:
                        flow.mode === "reauthenticate" ? "reauthentication-required" : "unknown",
                    }}
                    flowId={flow.id}
                    flowRevision={flow.revision}
                    oauthCredentialId={exactOAuthCredentialId}
                    onConnected={handleOAuthConnected}
                  />
                </div>
              )}

              {flow.status === "awaiting-oauth" && (!oauthDeclaration || !oauthProviderId) && (
                <p
                  role="alert"
                  tabIndex={-1}
                  data-setup-focus-status
                  className="text-[10px] text-destructive"
                >
                  The active OAuth step is not declared by this manifest version.
                </p>
              )}

              {flow.status === "discovering" && (
                <p
                  role="status"
                  tabIndex={-1}
                  data-setup-focus-status
                  className="rounded-md bg-primary/5 p-3 text-xs text-muted-foreground"
                >
                  Discovering available capabilities and validating access…
                </p>
              )}

              {flow.status === "completed" && (
                <div
                  role="status"
                  tabIndex={-1}
                  data-setup-focus-status
                  className="rounded-md bg-emerald-500/10 p-3 text-xs text-emerald-500"
                >
                  {manifest.name} is connected and ready.
                </div>
              )}

              {(flow.status === "failed" || flow.status === "expired") && (
                <div
                  role="alert"
                  tabIndex={-1}
                  data-setup-focus-status
                  className="rounded-md bg-destructive/10 p-3 text-xs text-destructive"
                >
                  Setup {flow.status}.{" "}
                  {flow.failureCode ? <code>{flow.failureCode}</code> : "Please start again."}
                </div>
              )}

              {notice && (
                <p role="status" className="text-[10px] text-amber-500">
                  {notice}
                </p>
              )}
              {actionError && (
                <p role="alert" className="text-[10px] text-destructive">
                  {actionError}
                </p>
              )}
            </>
          )}
        </div>

        <footer className="mt-4 flex items-center justify-end gap-2 border-t border-border/40 pt-3">
          {flow?.status === "completed" ? (
            <button
              type="button"
              onClick={close}
              className="rounded-md bg-primary/15 px-3 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/25"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={close}
                disabled={submitting || loading}
                className="rounded-md px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                Close and resume later
              </button>
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={submitting || !flow || TERMINAL_STATUSES.has(flow.status)}
                className="rounded-md border border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40"
              >
                Cancel setup
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function DuplicateOption({
  value,
  checked,
  onChange,
  label,
}: {
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/40 px-2.5 py-2 text-[10px] hover:bg-muted/20">
      <input
        type="radio"
        name="duplicate-decision"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
      />
      <span>{label}</span>
    </label>
  );
}
