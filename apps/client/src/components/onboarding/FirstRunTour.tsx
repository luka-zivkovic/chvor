import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useConfigStore } from "@/stores/config-store";
import { useAppStore } from "@/stores/app-store";
import { useUIStore } from "@/stores/ui-store";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "chvor:first-run-tour-completed";

type Anchor =
  | "top-center"
  | "center"
  | "bottom-right"
  | "bottom-center"
  | "left-center";

interface TourStep {
  title: string;
  body: string;
  anchor: Anchor;
  highlight?: { selector: string; padding?: number };
  panel?: string; // panel id to highlight in nav, optional
}

const STEPS: TourStep[] = [
  {
    title: "Your AI is online",
    body: "Welcome — here's a 30-second tour of the brain canvas.",
    anchor: "center",
  },
  {
    title: "The top bar",
    body: "Open Brain, Persona, Skills, Tools, Memory, and more from up here. This is your control surface.",
    anchor: "top-center",
    highlight: { selector: "[data-tour='top-bar']", padding: 6 },
  },
  {
    title: "The brain canvas",
    body: "This is your AI's mind, live. Click any node — Brain, Skills, Memory, a Tool — to configure it.",
    anchor: "center",
  },
  {
    title: "Talk to your AI",
    body: "Chat lives on the right. Your AI learns from every conversation, stores memories, and runs skills + tools to help you.",
    anchor: "bottom-right",
    highlight: { selector: "[data-tour='chat-panel']", padding: 0 },
  },
];

const ANCHOR_STYLES: Record<Anchor, React.CSSProperties> = {
  center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  "top-center": { top: "60px", left: "50%", transform: "translateX(-50%)" },
  "bottom-right": { bottom: "100px", right: "32px" },
  "bottom-center": { bottom: "100px", left: "50%", transform: "translateX(-50%)" },
  "left-center": { top: "50%", left: "32px", transform: "translateY(-50%)" },
};

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
  padding: number;
}

function useHighlightRect(selector: string | undefined, padding: number): HighlightRect | null {
  const [rect, setRect] = useState<HighlightRect | null>(null);

  useEffect(() => {
    if (!selector) { setRect(null); return; }
    const measure = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height, padding });
    };
    measure();
    const ro = new ResizeObserver(measure);
    const target = document.querySelector(selector);
    if (target) ro.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selector, padding]);

  return rect;
}

interface Props {
  forceOpen?: boolean;
}

export function FirstRunTour({ forceOpen = false }: Props) {
  const persona = useConfigStore((s) => s.persona);
  const connected = useAppStore((s) => s.connected);
  const activePanel = useUIStore((s) => s.activePanel);
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const triggeredRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Trigger once after onboarding + first WS connect
  useEffect(() => {
    if (forceOpen) { setVisible(true); return; }
    if (triggeredRef.current) return;
    if (localStorage.getItem(STORAGE_KEY)) return;
    if (!persona?.onboarded) return;
    if (!connected) return;
    if (activePanel) return; // don't pop tour while user has a panel open
    triggeredRef.current = true;
    const timer = setTimeout(() => {
      if (mountedRef.current) setVisible(true);
    }, 1400);
    return () => clearTimeout(timer);
  }, [persona?.onboarded, connected, activePanel, forceOpen]);

  const close = useCallback(() => {
    if (!mountedRef.current) return;
    setVisible(false);
    setStep(0);
    localStorage.setItem(STORAGE_KEY, "1");
  }, []);

  const next = useCallback(() => {
    setStep((s) => {
      if (s >= STEPS.length - 1) {
        close();
        return 0;
      }
      return s + 1;
    });
  }, [close]);

  const back = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, close, next, back]);

  const current = STEPS[step];
  const highlightRect = useHighlightRect(current?.highlight?.selector, current?.highlight?.padding ?? 8);

  if (!visible || !current) return null;

  const isLast = step === STEPS.length - 1;

  return (
    <div className="pointer-events-auto fixed inset-0 z-[150]">
      {/* Soft backdrop — click anywhere to skip */}
      <div
        className="absolute inset-0 bg-background/55 backdrop-blur-[3px] transition-opacity"
        onClick={close}
      />

      {/* Spotlight ring around highlighted element */}
      <AnimatePresence>
        {highlightRect && (
          <motion.div
            key={`highlight-${step}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="pointer-events-none absolute rounded-xl"
            style={{
              top: highlightRect.top - highlightRect.padding,
              left: highlightRect.left - highlightRect.padding,
              width: highlightRect.width + highlightRect.padding * 2,
              height: highlightRect.height + highlightRect.padding * 2,
              boxShadow:
                "0 0 0 9999px oklch(0.17 0 0 / 0.55), 0 0 0 2px oklch(0.62 0.13 250 / 0.7), 0 0 36px oklch(0.62 0.13 250 / 0.45)",
            }}
          />
        )}
      </AnimatePresence>

      {/* Tour card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`card-${step}`}
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          className="absolute"
          style={ANCHOR_STYLES[current.anchor]}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Tour step ${step + 1} of ${STEPS.length}: ${current.title}`}
        >
          <div className="glass-strong relative w-[340px] rounded-xl border border-border/60 p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <span className="hud-text">
                Step {step + 1} / {STEPS.length}
              </span>
              <div className="flex items-center gap-1">
                {STEPS.map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1 rounded-full transition-all",
                      i === step ? "w-5 bg-primary" : "w-3 bg-muted-foreground/30"
                    )}
                  />
                ))}
              </div>
            </div>
            <h3 className="text-sm font-semibold text-foreground">{current.title}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {current.body}
            </p>
            <div className="mt-4 flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={close}>
                Skip tour
              </Button>
              <div className="flex items-center gap-2">
                {step > 0 && (
                  <Button variant="ghost" size="sm" onClick={back}>
                    Back
                  </Button>
                )}
                <Button variant="primary" size="sm" onClick={next}>
                  {isLast ? "Got it" : "Next"}
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
