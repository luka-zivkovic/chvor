import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type SessionCredentialPinInfo } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getSessionPinRefreshDelays,
  readSessionPinsChangedDetail,
  SESSION_PINS_CHANGED_EVENT,
  notifySessionPinsChanged,
} from "../../lib/session-pins-events";

interface Props {
  compact?: boolean;
  showEmpty?: boolean;
  className?: string;
}

function formatPinnedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionCredentialPins({ compact = false, showEmpty = true, className }: Props) {
  const sessionId = useAppStore((s) => s.sessionId);
  const [pins, setPins] = useState<SessionCredentialPinInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const refreshTimersRef = useRef<number[]>([]);

  const loadPins = useCallback(async () => {
    if (!sessionId) {
      setPins([]);
      return;
    }
    setLoading(true);
    try {
      setPins(await api.sessions.credentialPins(sessionId));
    } catch (err) {
      console.warn("[session-pins] failed to load:", err);
      setPins([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadPins();
  }, [loadPins]);

  useEffect(() => {
    const clearRefreshTimers = () => {
      for (const timer of refreshTimersRef.current) window.clearTimeout(timer);
      refreshTimersRef.current = [];
    };

    const onChanged = (event: Event) => {
      clearRefreshTimers();
      const detail = readSessionPinsChangedDetail(event);
      const delays = getSessionPinRefreshDelays(detail.reason);
      for (const delay of delays) {
        const timer = window.setTimeout(() => {
          refreshTimersRef.current = refreshTimersRef.current.filter((value) => value !== timer);
          void loadPins();
        }, delay);
        refreshTimersRef.current.push(timer);
      }
    };

    window.addEventListener(SESSION_PINS_CHANGED_EVENT, onChanged);
    return () => {
      clearRefreshTimers();
      window.removeEventListener(SESSION_PINS_CHANGED_EVENT, onChanged);
    };
  }, [loadPins]);

  const unpin = useCallback(
    async (credentialType: string) => {
      if (!sessionId) return;
      setBusyKey(credentialType);
      try {
        await api.sessions.deleteCredentialPin(sessionId, credentialType);
        await loadPins();
        notifySessionPinsChanged({ reason: "unpin" });
        toast.success(`Unpinned ${credentialType} for this session`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to unpin credential");
      } finally {
        setBusyKey(null);
      }
    },
    [loadPins, sessionId]
  );

  const clearAll = useCallback(async () => {
    if (!sessionId || pins.length === 0) return;
    setBusyKey("__all");
    try {
      await api.sessions.clearCredentialPins(sessionId);
      await loadPins();
      notifySessionPinsChanged({ reason: "clear-all" });
      toast.success("Cleared session credential pins");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear pins");
    } finally {
      setBusyKey(null);
    }
  }, [loadPins, pins.length, sessionId]);

  if (compact && pins.length === 0) return null;
  if (!showEmpty && pins.length === 0) return null;

  return (
    <div
      className={cn(
        compact
          ? "rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs"
          : "rounded-lg border border-border bg-muted/10 p-3",
        className
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className={cn("font-semibold", compact ? "text-xs" : "text-sm")}>Session pins</div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Credential defaults used only in this conversation.
          </p>
        </div>
        {!compact && pins.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto px-2 py-1 text-[10px]"
            disabled={busyKey === "__all"}
            onClick={clearAll}
          >
            Clear all
          </Button>
        )}
      </div>

      {loading && pins.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Loading pins...</p>
      ) : pins.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No credential is pinned for this session yet. Choose “Pin for session” when asked.
        </p>
      ) : (
        <div className={cn("flex gap-2", compact ? "flex-wrap" : "flex-col")}>
          {pins.map((pin) => (
            <div
              key={`${pin.credentialType}:${pin.credentialId}`}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/50",
                compact ? "px-2 py-1" : "px-2.5 py-2"
              )}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-emerald-500">
                    {pin.credentialType}
                  </span>
                  <span className="truncate text-[11px] font-medium text-foreground">
                    {pin.credentialName ?? pin.credentialId}
                  </span>
                </div>
                {!compact && (
                  <p className="mt-0.5 text-[9px] text-muted-foreground">
                    Pinned {formatPinnedAt(pin.pinnedAt)} · {pin.credentialId}
                  </p>
                )}
              </div>
              <button
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                disabled={busyKey === pin.credentialType}
                onClick={() => void unpin(pin.credentialType)}
                title={`Unpin ${pin.credentialType}`}
              >
                Unpin
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
