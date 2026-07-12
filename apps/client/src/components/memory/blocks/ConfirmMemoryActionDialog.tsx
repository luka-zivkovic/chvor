import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

export function ConfirmMemoryActionDialog({
  title,
  description,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCancelRef.current();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="memory-confirm-title"
        aria-describedby="memory-confirm-description"
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl"
      >
        <h2 id="memory-confirm-title" className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        <p id="memory-confirm-description" className="mt-2 text-xs text-muted-foreground">
          {description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={onConfirm} autoFocus>
            {busy ? "Restoring…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
