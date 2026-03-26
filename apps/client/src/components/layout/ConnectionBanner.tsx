import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAppStore } from "../../stores/app-store";
import { cn } from "@/lib/utils";

export function ConnectionBanner() {
  const connected = useAppStore((s) => s.connected);
  const reconnecting = useAppStore((s) => s.reconnecting);
  const wasDisconnected = useRef(false);
  const hasMounted = useRef(false);

  const show = !connected || reconnecting;

  // Toast "Back online" when reconnection succeeds (skip initial mount)
  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      if (!connected) wasDisconnected.current = true;
      return;
    }
    if (!connected) {
      wasDisconnected.current = true;
    } else if (wasDisconnected.current) {
      wasDisconnected.current = false;
      toast.success("Back online");
    }
  }, [connected]);

  return (
    <div
      className={cn(
        "absolute top-10 right-0 left-0 z-40 flex items-center justify-center overflow-hidden border-b border-border/50 transition-all duration-300",
        show ? "h-8 opacity-100" : "h-0 opacity-0",
      )}
      style={{
        background: "oklch(0.14 0.005 285 / 0.90)",
        backdropFilter: "blur(12px)",
      }}
    >
      {reconnecting ? (
        <span className="flex items-center gap-2 text-[11px] text-yellow-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
          Reconnecting...
        </span>
      ) : (
        <span className="flex items-center gap-2 text-[11px] text-destructive">
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          Disconnected
        </span>
      )}
    </div>
  );
}
