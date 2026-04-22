import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { OAuthSynthesizedWizardData } from "@chvor/shared";

type Step = "register" | "config" | "consent" | "done" | "error";

interface Props {
  request: OAuthSynthesizedWizardData;
  onComplete: (connected: boolean) => void;
  onCancel: () => void;
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
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const stepRef = useRef<Step>(step);
  stepRef.current = step;

  // Pull the canonical redirect URL from the server so the user copy-pastes
  // exactly what /api/oauth/callback expects. We hit this even though the
  // server already echoed `redirectUriHint` in the wizard payload — the
  // env-var-derived value is authoritative on the server side.
  useEffect(() => {
    let cancelled = false;
    api.oauth.synthesizedRedirectUrl()
      .then((r) => { if (!cancelled) setRedirectUri(r.redirectUrl); })
      .catch(() => { /* hint is fine */ });
    return () => { cancelled = true; };
  }, []);

  // Listen for postMessage from the OAuth callback page.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || e.data.type !== "chvor-oauth-callback") return;
      // Origin check matches OAuthConnectButton — local file:// callback is
      // possible in the desktop app, so we accept "null" too.
      if (e.origin !== window.location.origin && e.origin !== "null") return;
      if (pollRef.current) clearInterval(pollRef.current);
      if (e.data.success) {
        setStep("done");
        onComplete(true);
      } else {
        setStep("error");
        setErrorMsg("OAuth was not completed.");
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [onComplete]);

  const scopes = useMemo(
    () => scopesText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    [scopesText],
  );

  const canLaunch =
    !!clientId.trim() && !!authUrl.trim() && !!tokenUrl.trim()
    && authUrl.startsWith("https://") && tokenUrl.startsWith("https://");

  const handleLaunch = useCallback(async () => {
    setErrorMsg(null);
    if (!canLaunch) {
      setErrorMsg("Client ID, authUrl (https), and tokenUrl (https) are required.");
      return;
    }
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
      setStep("consent");
      const popup = window.open(result.redirectUrl, "_blank", "width=600,height=700");
      popupRef.current = popup;
      // Fallback: if postMessage never fires, watch for the popup closing.
      pollRef.current = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(pollRef.current);
          if (stepRef.current === "consent") {
            setStep("error");
            setErrorMsg("Popup closed before completion. You can retry below.");
          }
        }
      }, 1000);
    } catch (err) {
      setStep("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [authUrl, canLaunch, clientId, clientSecret, request.credentialType, request.providerName, scopes, tokenUrl]);

  const handleCancel = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      try { popupRef.current.close(); } catch { /* noop */ }
    }
    if (pollRef.current) clearInterval(pollRef.current);
    onCancel();
  }, [onCancel]);

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
          <div className="font-medium">Connect {request.providerName} (OAuth)</div>
          <div className="text-xs text-muted-foreground">
            {step === "register" && "Step 1 of 3 — register Chvor's redirect URL with the provider"}
            {step === "config" && "Step 2 of 3 — paste your OAuth app credentials"}
            {step === "consent" && "Step 3 of 3 — complete consent in the popup"}
            {step === "done" && "Connected!"}
            {step === "error" && "Something went wrong"}
          </div>
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
            create (or open) an OAuth app, and add the URL below to its allowed redirect/callback URIs.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-black/30 px-2 py-1 text-[11px]">{redirectUri}</code>
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
          <ConfigRow label="Client Secret" value={clientSecret} onChange={setClientSecret} type="password" />
          <ConfigRow label="Authorization URL" value={authUrl} onChange={setAuthUrl} required placeholder="https://example.com/oauth/authorize" />
          <ConfigRow label="Token URL" value={tokenUrl} onChange={setTokenUrl} required placeholder="https://example.com/oauth/token" />
          <ConfigRow label="Scopes (space-separated)" value={scopesText} onChange={setScopesText} placeholder="scope1 scope2" />

          {errorMsg && (
            <div className="text-xs text-destructive">{errorMsg}</div>
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
          <p className="text-muted-foreground">If the popup didn't open, check your browser's popup blocker.</p>
          <div className="flex justify-end pt-1">
            <button
              onClick={() => setStep("config")}
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
          <div className="text-xs text-destructive">{errorMsg ?? "OAuth failed."}</div>
          <div className="flex justify-end">
            <button
              onClick={() => { setStep("config"); setErrorMsg(null); }}
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
  label, value, onChange, required, placeholder, type = "text",
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
        {label}{required && <span className="text-destructive"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-0.5 w-full rounded-md bg-black/30 px-2 py-1 text-xs border border-white/5 focus:border-primary/50 focus:outline-none"
      />
    </label>
  );
}
