import { useEffect } from "react";
import { Button } from "../ui/button";

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Canvas",
    shortcuts: [
      { keys: ["F"], description: "Toggle canvas fullscreen" },
      { keys: ["Esc"], description: "Exit fullscreen / close panel" },
    ],
  },
  {
    title: "Conversations",
    shortcuts: [
      { keys: ["Ctrl", "Shift", "N"], description: "New conversation" },
      { keys: ["Ctrl", "Shift", "L"], description: "Toggle conversations panel" },
    ],
  },
  {
    title: "Help",
    shortcuts: [{ keys: ["?"], description: "Show this cheat sheet" }],
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="glass-strong relative w-full max-w-md rounded-xl border border-border/60 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">Keyboard shortcuts</h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close shortcuts">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Button>
        </header>

        <div className="flex flex-col gap-5">
          {GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-2">
              <h3 className="hud-text">{group.title}</h3>
              <ul className="flex flex-col gap-1.5">
                {group.shortcuts.map((sc) => (
                  <li
                    key={sc.description}
                    className="flex items-center justify-between text-xs text-foreground/80"
                  >
                    <span>{sc.description}</span>
                    <span className="flex items-center gap-1">
                      {sc.keys.map((key, i) => (
                        <kbd
                          key={`${key}-${i}`}
                          className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
