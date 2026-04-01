import { useState, useEffect } from "react";
import { useUIStore } from "../../stores/ui-store";
import { cn } from "@/lib/utils";
import { CredentialsContent, SecurityContent, SessionsContent, BackupContent } from "../panels/SettingsPanel";
import { VoiceSettingsContent } from "../panels/VoiceSettingsContent";
import { PermissionsContent } from "../panels/PermissionsPanel";

type SettingsSection = "permissions" | "connections" | "voice" | "security" | "sessions" | "backup";

const SECTIONS: { id: SettingsSection; label: string; description: string; icon: React.ReactNode }[] = [
  {
    id: "permissions",
    label: "Permissions",
    description: "PC control, shell, filesystem & network",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    id: "connections",
    label: "Connections",
    description: "API keys & provider credentials",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6A5 5 0 0 1 6 7h3" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    ),
  },
  {
    id: "voice",
    label: "Voice",
    description: "Speech-to-text & text-to-speech",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
  },
  {
    id: "security",
    label: "Security",
    description: "Authentication & API access",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Auto-reset, timeouts & triggers",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
  {
    id: "backup",
    label: "Backup",
    description: "Export, restore & scheduled backups",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  },
];

function SectionContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case "permissions":
      return <PermissionsContent />;
    case "connections":
      return <CredentialsContent />;
    case "voice":
      return <VoiceSettingsContent />;
    case "security":
      return <SecurityContent />;
    case "sessions":
      return <SessionsContent />;
    case "backup":
      return <BackupContent />;
    default:
      return null;
  }
}

export function SettingsOverlay() {
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const [activeSection, setActiveSection] = useState<SettingsSection>("permissions");

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settingsOpen, closeSettings]);

  if (!settingsOpen) return null;

  const activeMeta = SECTIONS.find((s) => s.id === activeSection);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-md"
        onClick={closeSettings}
      />

      {/* Settings container */}
      <div
        className="relative z-10 m-4 md:m-8 flex flex-1 overflow-hidden rounded-xl border border-border/50"
        style={{ background: "var(--glass-bg-strong)" }}
      >
        {/* Sidebar navigation */}
        <nav className="hidden md:flex w-56 shrink-0 flex-col border-r border-border/30 py-4">
          <div className="px-4 pb-4 mb-2 border-b border-border/30">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.15em] text-foreground">
              Settings
            </h2>
          </div>

          <div className="flex flex-col gap-0.5 px-2">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
                  activeSection === section.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                )}
              >
                <span className="shrink-0 opacity-70">{section.icon}</span>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{section.label}</p>
                  <p className="text-[9px] text-muted-foreground/60 truncate">{section.description}</p>
                </div>
              </button>
            ))}
          </div>
        </nav>

        {/* Mobile section selector */}
        <div className="md:hidden flex shrink-0 border-b border-border/30 overflow-x-auto">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={cn(
                "shrink-0 px-3 py-2.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
                activeSection === section.id
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted-foreground"
              )}
            >
              {section.label}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Content header */}
          <div className="flex shrink-0 items-center justify-between border-b border-border/30 px-6 py-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">{activeMeta?.label}</h3>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{activeMeta?.description}</p>
            </div>
            <button
              onClick={closeSettings}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              title="Close settings (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="max-w-2xl">
              <SectionContent section={activeSection} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
