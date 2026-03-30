import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface Props {
  title: string;
  subtitle?: string;
  info?: string;
  headerAction?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}

export function SlideOverPanel({
  title,
  subtitle,
  info,
  headerAction,
  onClose,
  children,
  width,
}: Props) {
  return (
    <div
      className={cn(
        "animate-slide-in-left relative h-full z-30 w-full",
        "flex flex-col md:rounded-r-2xl",
        "border-r border-border/50 backdrop-blur-xl"
      )}
      style={{
        maxWidth: width ?? 520,
        background: "var(--glass-bg-strong)",
      }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-4">
        <div className="min-w-0 flex items-center gap-2">
          <div>
            <h2 className="hud-label text-muted-foreground">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                {subtitle}
              </p>
            )}
          </div>
          {info && <InfoTooltip text={info} />}
        </div>
        <div className="flex items-center gap-2">
          {headerAction}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <button
        className="flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/20 text-[8px] font-semibold text-muted-foreground/40 transition-colors hover:border-muted-foreground/40 hover:text-muted-foreground/70"
        onClick={(e) => { e.stopPropagation(); setShow((s) => !s); }}
      >
        i
      </button>
      {show && (
        <div
          className="absolute left-0 top-6 z-50 w-52 rounded-md border border-border/50 bg-card/95 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground shadow-lg backdrop-blur-md"
        >
          {text}
        </div>
      )}
    </div>
  );
}
