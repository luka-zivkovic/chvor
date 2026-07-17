import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { OAuthSynthesizedWizardData } from "@chvor/shared";

type Step = "register" | "config" | "consent" | "done" | "error";

interface Props {
  request: OAuthSynthesizedWizardData;
  onComplete: (connected: boolean) => void;
  onCancel: () => void;
}

interface OAuthAttempt {
  connectionId: string;
  flowId: string;
  flowRevision?: number;
  callbackOrigin: string;
  oauthCredentialId?: string;
}

const TERMINAL_FLOW_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
const STEP_DESCRIPTIONS: Record<Step, string> = {
  register: "Step 1 of 3 — register Chvor's redirect URL with the provider",
  config: "Step 2 of 3 — paste your OAuth app credentials",
  consent: "Step 3 of 3 — complete consent in the popup",
  done: "Connected!",
  error: "Something went wrong",
};

function safeCallbackId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function safeCallbackOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function safeRevision(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function closePopupBestEffort(popup: Window | null) {
  if (!popup || popup === window || popup.closed) return;
  try {
    popup.close();
  } catch {
    // Popup teardown is best-effort.
  }
}

/**
 * 3-step wizard that walks the user through OAuth registration for a service
 * the AI discovered but isn't in the built-in OAUTH_PROVIDERS registry.
 *
 *   1. Register — show the redirect URL the user must whitelist with the
 *      provider's developer portal. Surfaced first because the user must
 *      complete this step in their browser before they can fill out step 2.
 *   2. Config — collect client_id / client_secret / scopes (with the AI's
 *      suggestions pre-filled, all editable).
 *   3. Consent — open the provider's auth page in a popup; postMessage from
 *      the /api/oauth/callback page resolves the wizard.
 */
export function OAuthSynthesizedWizard({ request, onComplete, onCancel }: Props) {
  const [step, setStep] = useState<Step>("register");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [redirectUri, setRedirectUri] = useState(request.redirectUriHint ?? "");

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authUrl, setAuthUrl] = useState(request.authUrl ?? "");
  const [tokenUrl, setTokenUrl] = useState(request.tokenUrl ?? "");
  const [scopesText, setScopesText] = useState((request.scopes ?? []).join(" "));

  const popupRef = useRef<Window | null>(null);
  const attemptRef = useRef<OAuthAttempt | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stepRef = useRef<Step>(step);
  const onCompleteRef = useRef(onComplete);
  const cancellationRef = useRef(new Set<string>());
  const launchGenerationRef = useRef(0);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusedStepRef = useRef<Step>(step);
  stepRef.current = step;
  onCompleteRef.current = onComplete;

  const cancelDurableAttempt = useCallback(
    async (attempt: OAuthAttempt, knownRevision?: number) => {
      const cancellationKey = `${attempt.flowId}:${attempt.connectionId}`;
      if (cancellationRef.current.has(cancellationKey)) return;
      cancellationRef.current.add(cancellationKey);

      const loadActiveRevision = async () => {
        const flow = await api.integrationSetup.get(attempt.flowId);
        if (flow.id !== attempt.flowId || TERMINAL_FLOW_STATUSES.has(flow.status)) return undefined;
        return safeRevision(flow.revision);
      };

      try {
        const revision = knownRevision ?? attempt.flowRevision ?? (await loadActiveRevision());
        if (!revision) return;
        try {
          await api.integrationSetup.cancel(attempt.flowId, revision);
        } catch (error: unknown) {
          if ((error as { status?: unknown }).status !== 409) return;
          const latestRevision = await loadActiveRevision();
          if (latestRevision && latestRevision !== revision) {
            await api.integrationSetup.cancel(attempt.flowId, latestRevision);
          }
        }
      } catch {
        // Cancellation is best-effort; CAS and terminal-state checks keep it fail-closed.
      }
    },
    []
  );

  const abandonActiveAttempt = useCallback(() => {
    launchGenerationRef.current += 1;
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = undefined;
    timeoutRef.current = undefined;
    const attempt = attemptRef.current;
    attemptRef.current = null;
    const popup = popupRef.current;
    popupRef.current = null;
    if (popup && !popup.closed) {
      try {
        popup.close();
      } catch {
        /* noop */
      }
    }
    if (attempt) void cancelDurableAttempt(attempt);
  }, [cancelDurableAttempt]);

  // Pull the canonical redirect URL from the server so the user copy-pastes
  // exactly what /api/oauth/callback expects. We hit this even though the
  // server already echoed `redirectUriHint` in the wizard payload — the
  // env-var-derived value is authoritative on the server side.
  useEffect(() => {
    let cancelled = false;
    api.oauth
      .synthesizedRedirectUrl()
      .then((r) => {
        if (!cancelled) setRedirectUri(r.redirectUrl);
      })
      .catch(() => {
        /* hint is fine */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (focusedStepRef.current === step) return;
    focusedStepRef.current = step;
    stepHeadingRef.current?.focus();
  }, [step]);

  // Listen for postMessage from the OAuth callback page.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const attempt = attemptRef.current;
      if (!e.data || e.data.type !== "chvor-oauth-callback") return;
      if (
        !attempt ||
        e.origin !== attempt.callbackOrigin ||
        !popupRef.current ||
        e.source !== popupRef.current ||
        e.data.connectionId !== attempt.connectionId ||
        e.data.flowId !== attempt.flowId
      ) {
        return;
      }
      const credentialId = safeCallbackId(e.data.credentialId);
      if (e.data.success === true && !credentialId) return;
      if (attempt.oauthCredentialId && credentialId !== attempt.oauthCredentialId) return;
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      pollRef.current = undefined;
      timeoutRef.current = undefined;
      attemptRef.current = null;
      if (e.data.success === true) closePopupBestEffort(popupRef.current);
      popupRef.current = null;
      if (e.data.success === true) {
        setStep("done");
        onCompleteRef.current(true);
      } else {
        setStep("error");
        setErrorMsg("OAuth was not completed.");
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      abandonActiveAttempt();
    };
  }, [abandonActiveAttempt]);

  const scopes = useMemo(
    () =>
      scopesText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [scopesText]
  );

  const canLaunch =
    !!clientId.trim() &&
    !!authUrl.trim() &&
    !!tokenUrl.trim() &&
    authUrl.startsWith("https://") &&
    tokenUrl.startsWith("https://");

  const handleLaunch = useCallback(async () => {
    setErrorMsg(null);
    if (!canLaunch) {
      setErrorMsg("Client ID, authUrl (https), and tokenUrl (https) are required.");
      return;
    }
    abandonActiveAttempt();
    const launchGeneration = launchGenerationRef.current;
    try {
      const result = await api.oauth.synthesizedInitiate({
        credentialType: request.credentialType,
        providerName: request.providerName,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        authUrl: authUrl.trim(),
        tokenUrl: tokenUrl.trim(),
        scopes,
      });
      const connectionId = safeCallbackId(result.connectionId);
      const resultFlowId = safeCallbackId(result.flowId);
      const callbackOrigin = safeCallbackOrigin(result.callbackOrigin);
      if (!connectionId || !resultFlowId) {
        throw new Error("OAuth provider did not return durable callback correlation.");
      }
      const flowRevision = safeRevision(result.flowRevision);
      const attempt: OAuthAttempt = {
        connectionId,
        flowId: resultFlowId,
        callbackOrigin: callbackOrigin ?? window.location.origin,
        ...(flowRevision ? { flowRevision } : {}),
        ...(result.oauthCredentialId ? { oauthCredentialId: result.oauthCredentialId } : {}),
      };
      if (launchGenerationRef.current !== launchGeneration) {
        void cancelDurableAttempt(attempt);
        return;
      }
      if (!callbackOrigin) {
        void cancelDurableAttempt(attempt);
        throw new Error("OAuth provider did not return durable callback correlation.");
      }
      attemptRef.current = attempt;
      setStep("consent");
      const popup = window.open(result.redirectUrl, "_blank", "width=600,height=700");
      if (!popup) {
        attemptRef.current = null;
        void cancelDurableAttempt(attempt);
        setStep("error");
        setErrorMsg("The OAuth popup was blocked. Allow popups and try again.");
        return;
      }
      popupRef.current = popup;
      // Fallback: if postMessage never fires, watch for the popup closing.
      pollRef.current = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(pollRef.current);
          pollRef.current = undefined;
          const attempt = attemptRef.current;
          timeoutRef.current = setTimeout(async () => {
            if (!attempt || stepRef.current !== "consent") return;
            let activeRevision: number | undefined;
            try {
              const flow = await api.integrationSetup.get(attempt.flowId);
              const completedCredentialId = safeCallbackId(flow.oauthCredentialId);
              const completed =
                flow.id === attempt.flowId &&
                flow.authStatus === "active" &&
                flow.status !== "awaiting-oauth" &&
                flow.status !== "failed" &&
                flow.status !== "cancelled" &&
                flow.status !== "expired" &&
                completedCredentialId !== undefined &&
                (attempt.oauthCredentialId === undefined ||
                  completedCredentialId === attempt.oauthCredentialId);
              if (flow.id === attempt.flowId && !TERMINAL_FLOW_STATUSES.has(flow.status)) {
                activeRevision = safeRevision(flow.revision);
              }
              if (completed) {
                if (attemptRef.current !== attempt || stepRef.current !== "consent") return;
                attemptRef.current = null;
                popupRef.current = null;
                setStep("done");
                onCompleteRef.current(true);
                return;
              }
            } catch {
              // Never fall back to an arbitrary active OAuth account.
            }
            if (attemptRef.current !== attempt || stepRef.current !== "consent") return;
            attemptRef.current = null;
            popupRef.current = null;
            void cancelDurableAttempt(attempt, activeRevision);
            setStep("error");
            setErrorMsg("Popup closed before completion. You can retry below.");
          }, 1500);
        }
      }, 1000);
    } catch (err) {
      if (launchGenerationRef.current !== launchGeneration) return;
      setStep("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [
    authUrl,
    canLaunch,
    clientId,
    clientSecret,
    request.credentialType,
    request.providerName,
    scopes,
    tokenUrl,
    abandonActiveAttempt,
    cancelDurableAttempt,
  ]);

  const handleCancel = useCallback(() => {
    abandonActiveAttempt();
    onCancel();
  }, [abandonActiveAttempt, onCancel]);

  return (
    <div
      className="rounded-lg border p-4 space-y-3 text-sm"
      style={{
        background: "var(--glass-bg-strong)",
        border: "1px solid var(--glass-border)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">Connect {request.providerName} (OAuth)</h3>
          <h4
            ref={stepHeadingRef}
            tabIndex={-1}
            data-oauth-wizard-step-heading
            className="text-xs text-muted-foreground outline-none"
          >
            {STEP_DESCRIPTIONS[step]}
          </h4>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {STEP_DESCRIPTIONS[step]}
          </span>
        </div>
        <button
          onClick={handleCancel}
          className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          Cancel
        </button>
      </div>

      {request.helpText && step !== "done" && (
        <div className="text-xs text-muted-foreground">{request.helpText}</div>
      )}

      {step === "register" && (
        <div className="space-y-2">
          <p className="text-xs">
            Open <span className="font-medium">{request.providerName}</span>'s developer portal,
            create (or open) an OAuth app, and add the URL below to its allowed redirect/callback
            URIs.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-black/30 px-2 py-1 text-[11px]">
              {redirectUri}
            </code>
            <button
              onClick={() => navigator.clipboard?.writeText(redirectUri).catch(() => {})}
              className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              Copy
            </button>
          </div>
          <div className="flex justify-end pt-1">
            <button
              onClick={() => setStep("config")}
              className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              I've registered it →
            </button>
          </div>
        </div>
      )}

      {step === "config" && (
        <div className="space-y-2">
          <ConfigRow label="Client ID" value={clientId} onChange={setClientId} required />
          <ConfigRow
            label="Client Secret"
            value={clientSecret}
            onChange={setClientSecret}
            type="password"
          />
          <ConfigRow
            label="Authorization URL"
            value={authUrl}
            onChange={setAuthUrl}
            required
            placeholder="https://example.com/oauth/authorize"
          />
          <ConfigRow
            label="Token URL"
            value={tokenUrl}
            onChange={setTokenUrl}
            required
            placeholder="https://example.com/oauth/token"
          />
          <ConfigRow
            label="Scopes (space-separated)"
            value={scopesText}
            onChange={setScopesText}
            placeholder="scope1 scope2"
          />

          {errorMsg && (
            <div role="alert" className="text-xs text-destructive">
              {errorMsg}
            </div>
          )}

          <div className="flex justify-between pt-1">
            <button
              onClick={() => setStep("register")}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Back
            </button>
            <button
              onClick={handleLaunch}
              disabled={!canLaunch}
              className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
            >
              Launch consent →
            </button>
          </div>
        </div>
      )}

      {step === "consent" && (
        <div className="space-y-2 text-xs">
          <p>Complete the {request.providerName} consent flow in the popup window.</p>
          <p className="text-muted-foreground">
            If the popup didn't open, check your browser's popup blocker.
          </p>
          <div className="flex justify-end pt-1">
            <button
              onClick={() => {
                abandonActiveAttempt();
                setStep("config");
              }}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Edit credentials
            </button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="text-xs text-emerald-400">
          {request.providerName} connected successfully — Chvor will continue your task.
        </div>
      )}

      {step === "error" && (
        <div className="space-y-2">
          <div role="alert" className="text-xs text-destructive">
            {errorMsg ?? "OAuth failed."}
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => {
                setStep("config");
                setErrorMsg(null);
              }}
              className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigRow({
  label,
  value,
  onChange,
  required,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <input
        type={type}
        required={required}
        aria-required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-0.5 w-full rounded-md bg-black/30 px-2 py-1 text-xs border border-white/5 focus:border-primary/50 focus:outline-none"
      />
    </label>
  );
}
