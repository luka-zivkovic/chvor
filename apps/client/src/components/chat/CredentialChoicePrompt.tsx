import { useState, useEffect, useCallback, useRef } from "react";
import type { CredentialChoiceRequestData, GatewayClientEvent } from "@chvor/shared";
import { useAppStore } from "../../stores/app-store";
import { notifySessionPinsChanged } from "../../lib/session-pins-events";

interface Props {
  request: CredentialChoiceRequestData;
  onSend: (event: GatewayClientEvent) => void;
}

export function CredentialChoicePrompt({ request, onSend }: Props) {
  const respondToCredentialChoice = useAppStore((s) => s.respondToCredentialChoice);
  const [selectedId, setSelectedId] = useState(() => request.candidates[0]?.id ?? "");
  const [remainingMs, setRemainingMs] = useState(() => {
    const elapsed = Date.now() - new Date(request.timestamp).getTime();
    return Math.max(0, request.timeoutMs - elapsed);
  });
  const respondedRef = useRef(false);
  const [responded, setResponded] = useState(false);

  const respond = useCallback(
    (action: "use-once" | "pin-session" | "cancel") => {
      if (respondedRef.current) return;
      respondedRef.current = true;
      setResponded(true);
      onSend({
        type: "credential.choice.respond",
        data: {
          requestId: request.requestId,
          action,
          ...(action === "cancel" ? {} : { credentialId: selectedId }),
        },
      });
      respondToCredentialChoice(request.requestId);
      if (action === "pin-session") {
        notifySessionPinsChanged({ reason: "pin-session" });
      }
    },
    [onSend, request.requestId, respondToCredentialChoice, selectedId]
  );

  useEffect(() => {
    if (respondedRef.current) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - new Date(request.timestamp).getTime();
      const remaining = Math.max(0, request.timeoutMs - elapsed);
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        respond("cancel");
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [request.timestamp, request.timeoutMs, respond]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") respond("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [respond]);

  if (responded || remainingMs <= 0) return null;

  const seconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const timeStr = `${minutes}:${secs.toString().padStart(2, "0")}`;
  const selected = request.candidates.find((c) => c.id === selectedId);

  return (
    <div
      className="mx-2 mb-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs"
      style={{ backdropFilter: "blur(8px)" }}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-foreground">
            Choose {request.credentialType} credential
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {request.toolName ? `${request.toolName} needs a credential.` : "Pick a credential."}
          </div>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{timeStr}</span>
      </div>

      <div className="mb-2 rounded border border-border/40 bg-background/40 px-2 py-1.5 text-[10px] text-muted-foreground">
        {request.reason}
      </div>

      <div className="space-y-1.5">
        {request.candidates.map((candidate) => {
          const checked = candidate.id === selectedId;
          return (
            <label
              key={candidate.id}
              className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-2 transition-colors ${
                checked
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/40 bg-background/40 hover:bg-muted/40"
              }`}
            >
              <input
                type="radio"
                className="mt-0.5"
                checked={checked}
                onChange={() => setSelectedId(candidate.id)}
              />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{candidate.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {candidate.id}
                </span>
                {candidate.usageContext && (
                  <span className="block text-[10px] text-muted-foreground">
                    Context: {candidate.usageContext}
                  </span>
                )}
                {candidate.testStatus && (
                  <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                    {candidate.testStatus}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={!selected}
          onClick={() => respond("use-once")}
          className="rounded border border-border/50 bg-background px-3 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
        >
          Use once
        </button>
        <button
          disabled={!selected}
          onClick={() => respond("pin-session")}
          className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-500 hover:bg-emerald-500/20 disabled:opacity-50"
        >
          Pin for session
        </button>
        <button
          onClick={() => respond("cancel")}
          className="rounded border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-500/20"
        >
          Cancel <span className="text-muted-foreground/60">(Esc)</span>
        </button>
      </div>
    </div>
  );
}
