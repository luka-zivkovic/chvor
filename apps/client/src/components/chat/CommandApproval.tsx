import { useState, useEffect, useCallback, useRef } from "react";
import type { CommandApprovalRequest, GatewayClientEvent } from "@chvor/shared";
import { useAppStore } from "../../stores/app-store";

const APPROVAL_TIMEOUT_MS = 125_000; // 5s buffer over server's 120s — ensures server times out first

interface Props {
  approval: CommandApprovalRequest;
  onSend: (event: GatewayClientEvent) => void;
}

export function CommandApproval({ approval, onSend }: Props) {
  const respondToApproval = useAppStore((s) => s.respondToApproval);
  const [remainingMs, setRemainingMs] = useState(() => {
    const elapsed = Date.now() - new Date(approval.timestamp).getTime();
    return Math.max(0, APPROVAL_TIMEOUT_MS - elapsed);
  });
  // Synchronous ref guard — prevents double-click sending duplicate WS messages
  const respondedRef = useRef(false);
  const [responded, setResponded] = useState(false);

  const respond = useCallback(
    (approved: boolean, alwaysAllow?: boolean) => {
      if (respondedRef.current) return;
      respondedRef.current = true;
      setResponded(true);
      onSend({
        type: "command.respond",
        data: { requestId: approval.requestId, approved, alwaysAllow },
      });
      respondToApproval(approval.requestId, approved);
    },
    [approval.requestId, onSend, respondToApproval]
  );

  useEffect(() => {
    if (respondedRef.current) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - new Date(approval.timestamp).getTime();
      const remaining = Math.max(0, APPROVAL_TIMEOUT_MS - elapsed);
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        respond(false);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [approval.timestamp, approval.requestId, respond]);

  if (responded || remainingMs <= 0) return null;

  const seconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const timeStr = `${minutes}:${secs.toString().padStart(2, "0")}`;

  const isDangerous = approval.tier === "dangerous";
  const tierColor = isDangerous ? "text-destructive" : "text-status-warning";
  const borderColor = isDangerous
    ? "border-destructive/40"
    : "border-status-warning/40";
  const bgColor = isDangerous ? "bg-destructive/5" : "bg-status-warning/5";

  return (
    <div
      className={`rounded-lg border ${borderColor} ${bgColor} p-3 mx-2 mb-2`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`flex items-center gap-1.5 text-sm font-medium ${tierColor}`}>
          <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0"><circle cx="4" cy="4" r="4" fill="currentColor" /></svg>
          Command requires approval
        </span>
        <span className="text-xs text-muted-foreground ml-auto">{timeStr}</span>
      </div>

      <pre className="bg-background/30 rounded px-2 py-1.5 text-xs font-mono text-foreground/90 overflow-x-auto mb-2 whitespace-pre-wrap">
        {approval.command}
      </pre>

      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
        <span>
          Risk: <span className={`font-medium ${tierColor}`}>{approval.tier.toUpperCase()}</span>
        </span>
        <span className="text-muted-foreground/50">|</span>
        <span className="truncate" title={approval.workingDir}>
          {approval.workingDir}
        </span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => respond(true)}
          className="px-3 py-1 rounded text-xs font-medium bg-status-completed hover:bg-status-completed/90 text-primary-foreground transition-colors"
        >
          Approve
        </button>
        <button
          onClick={() => respond(true, true)}
          className="px-3 py-1 rounded text-xs font-medium bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30 transition-colors"
        >
          Always Allow
        </button>
        <button
          onClick={() => respond(false)}
          className="px-3 py-1 rounded text-xs font-medium bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
