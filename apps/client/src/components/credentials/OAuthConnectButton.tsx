import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { useFeatureStore } from "../../stores/feature-store";
import { cn } from "@/lib/utils";
import type { OAuthProviderDef } from "@chvor/shared";

type Status = "idle" | "loading" | "polling" | "success" | "error" | "needs-setup";

interface Props {
  provider: OAuthProviderDef & { connected?: boolean; hasSetupCredentials?: boolean };
  onConnected?: () => void;
  onSetupRequired?: (credentialType: string) => void;
  compact?: boolean;
}

export function OAuthConnectButton({ provider, onConnected, onSetupRequired, compact }: Props) {
  const [status, setStatus] = useState<Status>(provider.connected ? "success" : "idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const popupRef = useRef<Window | null>(null);
  const statusRef = useRef<Status>(status);
  statusRef.current = status;

  // Listen for postMessage from the OAuth callback popup
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "chvor-oauth-callback" && (e.origin === window.location.origin || e.origin === "null")) {
        if (e.data.success) {
          setStatus("success");
          useFeatureStore.getState().fetchOAuthState();
          onConnected?.();
        } else {
          setStatus("error");
          setErrorMsg("OAuth was not completed.");
        }
        if (pollRef.current) clearInterval(pollRef.current);
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [onConnected]);

  const handleConnect = useCallback(async () => {
    // Clear any stale timers from a previous attempt
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = undefined; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = undefined; }

    setStatus("loading");
    setErrorMsg(null);

    try {
      const result = await api.oauth.initiate(provider.id);

      // Open OAuth URL in a popup
      const popup = window.open(result.redirectUrl, "_blank", "width=600,height=700");
      popupRef.current = popup;
      setStatus("polling");

      // Poll for popup close (fallback if postMessage doesn't fire)
      pollRef.current = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(pollRef.current);
          // Give a moment for the callback to process, then refresh state
          timeoutRef.current = setTimeout(async () => {
            await useFeatureStore.getState().fetchOAuthState();
            const state = useFeatureStore.getState();
            const conn = state.oauthConnections.find(
              (c) => c.platform === provider.id && c.status === "active",
            );
            if (conn) {
              setStatus("success");
              onConnected?.();
            } else if (statusRef.current === "polling") {
              // Still polling — user may have closed without completing
              setStatus("idle");
            }
          }, 1500);
        }
      }, 1000);
    } catch (err: unknown) {
      const error = err as { needsSetup?: boolean; setupCredentialType?: string; message?: string };
      if (error.needsSetup && error.setupCredentialType) {
        setStatus("needs-setup");
        onSetupRequired?.(error.setupCredentialType);
      } else {
        setStatus("error");
        setErrorMsg(error.message ?? String(err));
      }
    }
  }, [provider.id, onConnected, onSetupRequired]);

  const handleDisconnect = useCallback(async () => {
    const connections = useFeatureStore.getState().oauthConnections;
    const conn = connections.find((c) => c.platform === provider.id);
    if (!conn) return;

    try {
      await api.oauth.disconnect(conn.id);
      setStatus("idle");
      useFeatureStore.getState().fetchOAuthState();
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Disconnect failed");
    }
  }, [provider.id]);

  if (status === "success" || provider.connected) {
    return (
      <div className={cn("flex items-center gap-2", compact && "gap-1.5")}>
        <span className="flex items-center gap-1 text-[10px] text-green-500">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Connected
        </span>
        {provider.method === "composio" && (
          <span className="text-[8px] text-muted-foreground/40">via Composio</span>
        )}
        <button
          onClick={handleDisconnect}
          className="text-[9px] text-muted-foreground/50 hover:text-destructive transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (status === "needs-setup") {
    return (
      <button
        onClick={() => onSetupRequired?.(provider.setupCredentialType ?? "")}
        className={cn(
          "rounded-md bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-500 hover:bg-amber-500/20 transition-colors",
          compact && "px-2 py-0.5 text-[9px]",
        )}
      >
        Setup required
      </button>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={handleConnect}
        disabled={status === "loading" || status === "polling"}
        className={cn(
          "rounded-md bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50",
          compact && "px-2 py-0.5 text-[9px]",
        )}
      >
        {status === "loading" ? "..." : status === "polling" ? "Waiting..." : "Connect"}
      </button>
      {provider.method === "composio" && status === "idle" && (
        <span className="text-[8px] text-muted-foreground/40">via Composio</span>
      )}
      {status === "error" && errorMsg && (
        <span className="text-[9px] text-destructive">{errorMsg}</span>
      )}
    </div>
  );
}
