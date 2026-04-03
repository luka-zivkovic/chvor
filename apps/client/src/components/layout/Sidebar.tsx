import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "../../stores/app-store";
import { useUIStore } from "../../stores/ui-store";
import { usePcStore } from "../../stores/pc-store";
import type { PanelId } from "../../stores/ui-store";

const NAV_ITEMS: { id: PanelId | "settings"; label: string; icon: ReactNode }[] = [
  {
    id: "persona",
    label: "Persona",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: "memory",
    label: "Memory",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
        <path d="M8.5 8.5v.01" /><path d="M16 15.5v.01" /><path d="M12 12v.01" />
        <path d="M11 17v.01" /><path d="M7 14v.01" />
      </svg>
    ),
  },
  {
    id: "knowledge",
    label: "Knowledge",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        <path d="M8 7h8" /><path d="M8 11h6" />
      </svg>
    ),
  },
  {
    id: "schedules",
    label: "Schedules",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </svg>
    ),
  },
];

const TOOLTIP_CLASSES =
  "pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-md bg-card px-2.5 py-1 text-[10px] font-medium text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100";

function SidebarTooltip({ label }: { label: string }) {
  return <span className={TOOLTIP_CLASSES}>{label}</span>;
}

function ConnectionDot() {
  const connected = useAppStore((s) => s.connected);
  const reconnecting = useAppStore((s) => s.reconnecting);

  let dotColor = "bg-red-500";
  let label = "Disconnected";
  let extra = "";
  if (connected) {
    dotColor = "bg-green-500";
    label = "Connected";
  } else if (reconnecting) {
    dotColor = "bg-yellow-500";
    label = "Reconnecting";
    extra = "animate-pulse";
  }

  return (
    <div className="group relative flex items-center justify-center py-2">
      <span className={cn("h-2 w-2 rounded-full", dotColor, extra)} />
      <SidebarTooltip label={label} />
    </div>
  );
}

function PcControlButton() {
  const agents = usePcStore((s) => s.agents);
  const setViewerOpen = usePcStore((s) => s.setViewerOpen);
  const hasAgents = agents.length > 0;

  return (
    <div className="mb-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setViewerOpen(true)}
        className={cn(
          "group relative",
          hasAgents
            ? "text-emerald-400/70 hover:bg-muted hover:text-emerald-400"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
        title="PC Control"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 12V5.25" />
        </svg>
        {hasAgents && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400" />
        )}
        <SidebarTooltip label={hasAgents ? `PC Control (${agents.length})` : "PC Control"} />
      </Button>
    </div>
  );
}

export function Sidebar() {
  const activePanel = useUIStore((s) => s.activePanel);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const closePanel = useUIStore((s) => s.closePanel);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const openSettings = useUIStore((s) => s.openSettings);

  return (
    <aside className="flex h-full w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-3">
      {/* Logo / Home */}
      <Button
        variant="ghost"
        size="icon"
        onClick={closePanel}
        className="group relative mb-6 hover:bg-muted"
        title="Canvas"
      >
        <img src="/chvor_logo.svg" alt="Chvor" className="h-5 w-5 object-contain" />
        <SidebarTooltip label="Canvas" />
      </Button>

      {/* Nav items */}
      <nav className="flex flex-1 flex-col items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const isSettings = item.id === "settings";
          const isActive = isSettings ? settingsOpen : activePanel === item.id;
          return (
            <Button
              key={item.id}
              variant="ghost"
              size="icon"
              onClick={() => isSettings ? openSettings() : togglePanel(item.id as PanelId)}
              className={cn(
                "group relative",
                isActive
                  ? "bg-muted text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-primary" />
              )}
              {item.icon}
              <SidebarTooltip label={item.label} />
            </Button>
          );
        })}
      </nav>

      {/* PC Control button */}
      <PcControlButton />

      {/* Bottom section: connection */}
      <div className="flex flex-col items-center gap-2 border-t border-sidebar-border pt-3">
        <ConnectionDot />
      </div>
    </aside>
  );
}
