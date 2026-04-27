import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export interface EmptyStateProps {
  /** Optional icon (any React node — usually an SVG or lucide icon). */
  icon?: React.ReactNode;
  /** Short heading. */
  title: string;
  /** Optional supporting text below the heading. */
  description?: React.ReactNode;
  /** Primary action — renders a button when provided. */
  action?: {
    label: string;
    onClick: () => void;
    variant?: React.ComponentProps<typeof Button>["variant"];
  };
  /** Secondary action — renders a ghost button when provided. */
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
  /** Density. `compact` works well inline; `default` fills a panel. */
  size?: "compact" | "default";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  size = "default",
}: EmptyStateProps) {
  const compact = size === "compact";
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center text-center",
        compact ? "gap-2 p-4" : "gap-3 p-8",
        className
      )}
    >
      {icon && (
        <div
          className={cn(
            "flex items-center justify-center rounded-full bg-muted/40 text-muted-foreground",
            compact ? "h-9 w-9" : "h-12 w-12"
          )}
        >
          {icon}
        </div>
      )}
      <h3 className={cn("font-semibold text-foreground", compact ? "text-sm" : "text-base")}>
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            "max-w-sm text-muted-foreground",
            compact ? "text-xs" : "text-sm"
          )}
        >
          {description}
        </p>
      )}
      {(action || secondaryAction) && (
        <div className={cn("flex gap-2", compact ? "mt-1" : "mt-2")}>
          {action && (
            <Button
              variant={action.variant ?? "primary"}
              size={compact ? "sm" : "md"}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              variant="ghost"
              size={compact ? "sm" : "md"}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
