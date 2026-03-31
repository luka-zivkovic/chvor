import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePersonaStore } from "@/stores/persona-store";

const STORAGE_KEY = "chvor:canvas-hint-shown";

/**
 * One-time overlay hint shown after onboarding completes,
 * teaching users that canvas nodes are clickable.
 */
export function CanvasHint() {
  const [visible, setVisible] = useState(false);
  const mountedRef = useRef(true);
  const persona = usePersonaStore((s) => s.persona);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const dismiss = useCallback(() => {
    if (!mountedRef.current) return;
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, "1");
  }, []);

  // Only show after onboarding is complete
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    if (!persona?.onboarded) return;
    const timer = setTimeout(() => {
      if (mountedRef.current) setVisible(true);
    }, 1200);
    return () => clearTimeout(timer);
  }, [persona?.onboarded]);

  // Auto-dismiss after 8 seconds
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(dismiss, 8000);
    return () => clearTimeout(timer);
  }, [visible, dismiss]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="pointer-events-auto fixed bottom-20 left-1/2 z-50 -translate-x-1/2"
          onClick={dismiss}
        >
          <div
            className="flex items-center gap-3 rounded-xl border border-border/40 px-5 py-3 text-sm text-foreground shadow-lg cursor-pointer"
            style={{
              background: "var(--glass-bg)",
              backdropFilter: "blur(20px) saturate(1.2)",
            }}
          >
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
            <span>
              <span className="font-medium">Click any node</span>
              <span className="text-muted-foreground"> on the canvas to configure it</span>
            </span>
            <span className="ml-2 text-[10px] text-muted-foreground/50">click to dismiss</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
