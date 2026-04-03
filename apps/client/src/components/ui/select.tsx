import * as React from "react";
import { cn } from "@/lib/utils";

/* ─── Trigger (the button that shows the current value) ─── */

export interface SelectProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  children: React.ReactNode;
}

export function Select({ value, onChange, placeholder, children, className, ...props }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Find the label for the current value from children
  const options = React.Children.toArray(children).filter(
    (child): child is React.ReactElement<SelectOptionProps> =>
      React.isValidElement(child) && (child.type as unknown) === SelectOption
  );
  const selectedOption = options.find((o) => o.props.value === value);
  const displayLabel = selectedOption?.props.children ?? placeholder ?? value;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex w-full items-center justify-between rounded-md border border-border/40 bg-transparent px-2 py-1.5 text-[11px] text-foreground transition-colors",
          "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        onClick={() => setOpen((o) => !o)}
        {...props}
      >
        <span className="truncate">{displayLabel}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("ml-1 shrink-0 opacity-50 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className={cn(
            "absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border/40",
            "bg-popover text-popover-foreground shadow-md",
            "animate-in fade-in-0 zoom-in-95"
          )}
        >
          {options.map((option) => (
            <SelectOptionInternal
              key={option.props.value}
              value={option.props.value}
              selected={option.props.value === value}
              disabled={option.props.disabled}
              onSelect={(v) => {
                onChange(v);
                setOpen(false);
              }}
            >
              {option.props.children}
            </SelectOptionInternal>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── Option (public API for declaring options) ─── */

export interface SelectOptionProps {
  value: string;
  children: React.ReactNode;
  disabled?: boolean;
}

/** Declarative option — rendered internally by Select. */
export function SelectOption(_props: SelectOptionProps): React.ReactElement | null {
  // This component is never rendered directly; Select reads its props.
  return null;
}

/* ─── Internal option renderer ─── */

function SelectOptionInternal({
  value,
  selected,
  disabled,
  children,
  onSelect,
}: {
  value: string;
  selected: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onSelect: (v: string) => void;
}) {
  return (
    <li
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      className={cn(
        "cursor-pointer px-2 py-1.5 text-[11px] transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        selected && "bg-accent/50 text-accent-foreground",
        disabled && "pointer-events-none opacity-50"
      )}
      onClick={() => {
        if (!disabled) onSelect(value);
      }}
    >
      {children}
    </li>
  );
}
