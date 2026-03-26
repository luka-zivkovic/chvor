import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface Props {
  title: string;
  subtitle?: string;
  headerAction?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}

export function SlideOverPanel({
  title,
  subtitle,
  headerAction,
  onClose,
  children,
  width,
}: Props) {
  return (
    <div
      className={cn(
        "animate-slide-in-left relative h-full z-30",
        "flex flex-col rounded-r-2xl",
        "border-r border-border/50 backdrop-blur-xl"
      )}
      style={{
        width: width ?? 520,
        background: "var(--glass-bg-strong)",
      }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-5 py-4">
        <div className="min-w-0">
          <h2 className="hud-label text-muted-foreground">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-[10px] text-muted-foreground/60">
              {subtitle}
            </p>
          )}
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
