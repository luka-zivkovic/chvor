import { useState, useEffect, useCallback, useRef } from "react";
import type { SynthesizedConfirmData, GatewayClientEvent } from "@chvor/shared";
import { useAppStore } from "../../stores/app-store";

const FALLBACK_TIMEOUT_MS = 5 * 60_000;

interface Props {
  confirm: SynthesizedConfirmData;
  onSend: (event: GatewayClientEvent) => void;
}

export function SynthesizedConfirm({ confirm, onSend }: Props) {
  const respondToSynthesizedConfirm = useAppStore((s) => s.respondToSynthesizedConfirm);

  const totalTimeoutMs = confirm.timeoutMs > 0 ? confirm.timeoutMs : FALLBACK_TIMEOUT_MS;
  const [remainingMs, setRemainingMs] = useState(() => {
    const elapsed = Date.now() - new Date(confirm.timestamp).getTime();
    return Math.max(0, totalTimeoutMs - elapsed);
  });
  const respondedRef = useRef(false);
  const [responded, setResponded] = useState(false);

  const sendDecision = useCallback(
    (decision: "allow-once" | "allow-session" | "deny") => {
      if (respondedRef.current) return;
      respondedRef.current = true;
      setResponded(true);
      onSend({
        type: "synthesized.respond",
        data: { requestId: confirm.requestId, decision },
      });
      respondToSynthesizedConfirm(confirm.requestId);
    },
    [confirm.requestId, onSend, respondToSynthesizedConfirm],
  );

  useEffect(() => {
    if (respondedRef.current) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - new Date(confirm.timestamp).getTime();
      const remaining = Math.max(0, totalTimeoutMs - elapsed);
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        sendDecision("deny");
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [confirm.timestamp, totalTimeoutMs, sendDecision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") sendDecision("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sendDecision]);

  if (responded || remainingMs <= 0) return null;

  const methodColor =
    confirm.method === "GET"
      ? "text-emerald-500"
      : confirm.method === "DELETE"
      ? "text-red-500"
      : "text-amber-500";

  const seconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const timeStr = `${minutes}:${secs.toString().padStart(2, "0")}`;

  const hasPathParams = confirm.pathParams && Object.keys(confirm.pathParams).length > 0;
  const hasQueryParams = confirm.queryParams && Object.keys(confirm.queryParams).length > 0;
  const hasBody = confirm.body !== undefined && confirm.body !== null;
  const hasStructuredArgs = hasPathParams || hasQueryParams || hasBody;

  // Legacy argsPreview fallback: only show if no structured args were provided
  // (server may be older than client during rolling upgrades).
  const showLegacyPreview =
    !hasStructuredArgs && confirm.argsPreview && confirm.argsPreview !== "{}";

  return (
    <div
      className="rounded-md border border-border/50 bg-background/80 p-3 text-xs space-y-2"
      style={{ backdropFilter: "blur(8px)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{confirm.toolName}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className={`font-mono font-semibold ${methodColor}`}>{confirm.method}</span>
          <span className="font-mono text-muted-foreground truncate max-w-[280px]">
            {confirm.path}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground tabular-nums">{timeStr}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              confirm.verified
                ? "bg-emerald-500/10 text-emerald-500"
                : "bg-amber-500/10 text-amber-500"
            }`}
            title={
              confirm.source === "openapi"
                ? "endpoint discovered from a verified OpenAPI spec"
                : "endpoint drafted by the AI — no spec was verified; check carefully"
            }
          >
            {confirm.source === "openapi" ? "from openapi.json" : "ai-drafted"}
          </span>
        </div>
      </div>

      <div className="text-muted-foreground break-all font-mono text-[10px]">
        {confirm.resolvedUrl}
      </div>

      {!confirm.verified && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-500">
          ⚠ unverified — this tool was drafted by the AI without a confirmed spec.
          Review the call carefully before allowing.
        </div>
      )}

      {hasPathParams && (
        <ParamTable label="Path" entries={confirm.pathParams as Record<string, unknown>} />
      )}

      {hasQueryParams && (
        <ParamTable label="Query" entries={confirm.queryParams as Record<string, unknown>} />
      )}

      {hasBody && (
        <div className="space-y-1">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">Body</div>
          <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[10px] font-mono max-h-48">
            {formatJson(confirm.body)}
          </pre>
        </div>
      )}

      {showLegacyPreview && (
        <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-[10px] font-mono">
          {confirm.argsPreview}
        </pre>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {confirm.options.includes("allow-once") && (
          <button
            onClick={() => sendDecision("allow-once")}
            className="rounded border border-border/50 bg-background px-3 py-1 text-xs font-medium hover:bg-muted/50"
          >
            Allow once
          </button>
        )}
        {confirm.options.includes("allow-session") && (
          <button
            onClick={() => sendDecision("allow-session")}
            className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-500 hover:bg-emerald-500/20"
          >
            Allow for session
          </button>
        )}
        <button
          onClick={() => sendDecision("deny")}
          className="rounded border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-500 hover:bg-red-500/20"
        >
          Deny <span className="text-muted-foreground/60">(Esc)</span>
        </button>
      </div>
    </div>
  );
}

function ParamTable({ label, entries }: { label: string; entries: Record<string, unknown> }) {
  const keys = Object.keys(entries);
  if (keys.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className="rounded bg-muted/40 p-2 text-[10px] font-mono space-y-0.5">
        {keys.map((k) => (
          <div key={k} className="flex gap-2">
            <span className="text-muted-foreground shrink-0">{k}</span>
            <span className="text-muted-foreground/40">=</span>
            <span className="break-all">{formatScalar(entries[k])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatScalar(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2).slice(0, 4000);
  } catch {
    return String(v);
  }
}
