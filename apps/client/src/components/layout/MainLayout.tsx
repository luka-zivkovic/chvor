import { useEffect } from "react";
import { TopBar } from "./HudOverlay";
import { SlideOverPanel } from "./SlideOverPanel";
import { ConnectionBanner } from "./ConnectionBanner";
import { BrainCanvas } from "../canvas/BrainCanvas";
import { CanvasHint } from "../onboarding/CanvasHint";
import { ChatPanel } from "../chat/ChatPanel";
import { SchedulesPanel } from "../panels/SchedulesPanel";
import { WebhooksPanel } from "../panels/WebhooksPanel";
import { MemoryPanel } from "../panels/MemoryPanel";
import { PersonaPanel } from "../panels/PersonaPanel";
import { BrainPanel } from "../panels/BrainPanel";
import { SkillDetailPanel } from "../panels/SkillDetailPanel";
import { SkillsPanel } from "../panels/SkillsPanel";
import { ToolsPanel } from "../panels/ToolsPanel";
import { ToolDetailPanel } from "../panels/ToolDetailPanel";
import { IntegrationDetailPanel } from "../panels/IntegrationDetailPanel";
import { ConversationsPanel } from "../panels/ConversationsPanel";
import ActivityPanel from "../panels/ActivityPanel";
import { EmotionHistoryPanel } from "../panels/EmotionHistoryPanel";
import { CanvasPage } from "../canvas-page/CanvasPage";
import { SettingsOverlay } from "../settings/SettingsOverlay";
import { KnowledgePanel } from "../panels/KnowledgePanel";
import { PcViewer } from "../pc-viewer/PcViewer";
import { useUIStore } from "../../stores/ui-store";
import type { PanelId } from "../../stores/ui-store";
import { useAppStore } from "../../stores/app-store";
import { useExecution } from "../../hooks/use-execution";
import { useGateway } from "../../hooks/use-gateway";
import { cn } from "@/lib/utils";

const MOBILE_NAV_ITEMS: Array<{ panel: PanelId; label: string }> = [
  { panel: "brain", label: "Brain" },
  { panel: "persona", label: "Persona" },
  { panel: "memory", label: "Memory" },
  { panel: "knowledge", label: "Knowledge" },
  { panel: "skills", label: "Skills" },
  { panel: "tools", label: "Tools" },
  { panel: "schedules", label: "Schedules" },
  { panel: "webhooks", label: "Webhooks" },
  { panel: "conversations", label: "Conversations" },
  { panel: "settings", label: "Settings" },
];

function MobileMenu() {
  const mobileMenuOpen = useUIStore((s) => s.mobileMenuOpen);
  const closeMobileMenu = useUIStore((s) => s.closeMobileMenu);
  const openPanel = useUIStore((s) => s.openPanel);
  const openSettings = useUIStore((s) => s.openSettings);

  if (!mobileMenuOpen) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={closeMobileMenu} />
      <nav
        className="absolute left-0 top-0 bottom-0 w-64 animate-slide-in-left flex flex-col gap-1 p-4 pt-14"
        style={{ background: "var(--glass-bg-strong)", borderRight: "1px solid var(--glass-border)" }}
      >
        {MOBILE_NAV_ITEMS.map(({ panel, label }) => (
          <button
            key={panel}
            onClick={() => {
              if (panel === "settings") { openSettings(); } else { openPanel(panel); }
              closeMobileMenu();
            }}
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground text-left"
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const PANEL_META: Record<string, { title: string; subtitle: string; width?: number; info?: string }> = {
  brain: { title: "Brain", subtitle: "LLM, persona & memory", info: "Central AI configuration — model, behavior, persona, and memory." },
  settings: { title: "Settings", subtitle: "API keys, voice, security & sessions", info: "API keys, voice, security, session lifecycle, and backups." },
  schedules: { title: "Schedules", subtitle: "Automated tasks & pulse", info: "Automated tasks that run on a cron schedule." },
  webhooks: { title: "Webhooks", subtitle: "External event subscriptions", info: "Incoming triggers from external services like GitHub or Notion." },
  memory: { title: "Memory", subtitle: "Learned facts & context", info: "Facts your AI has learned and remembers across conversations." },
  knowledge: { title: "Knowledge", subtitle: "Documents, URLs & resources", info: "Ingested documents, URLs, and resources for context." },
  persona: { title: "Persona", subtitle: "Identity & directives", info: "Your AI's identity, tone, style, and communication boundaries." },
  skills: { title: "Skills", subtitle: "Behavioral skills & workflows", info: "Behavioral skills that shape how your AI responds." },
  "skill-detail": { title: "Skill", subtitle: "Details & instructions" },
  tools: { title: "Tools", subtitle: "MCP capabilities & integrations", info: "External tools — filesystem, web, MCP servers." },
  "tool-detail": { title: "Tool", subtitle: "Details & MCP config" },
  "integration-detail": { title: "Connection", subtitle: "Status & credential" },
  conversations: { title: "Conversations", subtitle: "Browse and manage chat history" },
  activity: { title: "Activity", subtitle: "System events" },
  "emotion-history": { title: "Emotional World", subtitle: "Inner state, arc & patterns" },
};

function PanelContent({ panel }: { panel: string }) {
  switch (panel) {
    case "brain":
      return <BrainPanel />;
    case "settings":
      return null; // Settings now uses SettingsOverlay; all entry points redirect to openSettings()
    case "schedules":
      return <SchedulesPanel />;
    case "webhooks":
      return <WebhooksPanel />;
    case "memory":
      return <MemoryPanel />;
    case "knowledge":
      return <KnowledgePanel />;
    case "persona":
      return <PersonaPanel />;
    case "skills":
      return <SkillsPanel />;
    case "skill-detail":
      return <SkillDetailPanel />;
    case "tools":
      return <ToolsPanel />;
    case "tool-detail":
      return <ToolDetailPanel />;
    case "integration-detail":
      return <IntegrationDetailPanel />;
    case "conversations":
      return <ConversationsPanel />;
    case "activity":
      return <ActivityPanel />;
    case "emotion-history":
      return <EmotionHistoryPanel />;
    default:
      return null;
  }
}

/* ─── Expand/Collapse FAB ─── */

function ExpandFab() {
  const layoutMode = useUIStore((s) => s.layoutMode);
  const toggleCanvasExpand = useUIStore((s) => s.toggleCanvasExpand);
  const isExpanded = layoutMode === "canvas-expanded";

  return (
    <button
      onClick={toggleCanvasExpand}
      className={cn(
        "glass flex h-9 w-9 items-center justify-center rounded-full",
        "border border-border/50 text-muted-foreground transition-all duration-200",
        "hover:border-primary/40 hover:text-primary hover:shadow-[0_0_16px_oklch(0.62_0.13_250/0.25)]",
        isExpanded && "border-primary/30 text-primary"
      )}
      title={isExpanded ? "Exit fullscreen (Esc)" : "Expand canvas (F)"}
    >
      {isExpanded ? (
        /* Collapse icon — arrows inward */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 14 10 14 10 20" />
          <polyline points="20 10 14 10 14 4" />
          <line x1="14" y1="10" x2="21" y2="3" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      ) : (
        /* Expand icon — arrows outward */
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      )}
    </button>
  );
}

export function MainLayout() {
  const layoutMode = useUIStore((s) => s.layoutMode);
  const chatCollapsed = useUIStore((s) => s.chatCollapsed);
  const activePanel = useUIStore((s) => s.activePanel);
  const closePanel = useUIStore((s) => s.closePanel);
  const toggleCanvasExpand = useUIStore((s) => s.toggleCanvasExpand);
  const setLayoutMode = useUIStore((s) => s.setLayoutMode);

  useExecution();
  useGateway();

  const isExpanded = layoutMode === "canvas-expanded";
  const isCanvas = layoutMode === "canvas";
  const meta = activePanel ? PANEL_META[activePanel] : null;

  /* ─── Keyboard shortcuts ─── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Modifier combos work even in inputs
      if (e.ctrlKey && e.shiftKey && e.key === "N") {
        e.preventDefault();
        useAppStore.getState().newConversation();
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "L") {
        e.preventDefault();
        useUIStore.getState().togglePanel("conversations");
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "f" || e.key === "F") {
        toggleCanvasExpand();
      }
      if (e.key === "Escape") {
        if (isExpanded) {
          setLayoutMode("default");
        } else if (activePanel) {
          closePanel();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isExpanded, activePanel, toggleCanvasExpand, setLayoutMode, closePanel]);

  if (isCanvas) {
    return <CanvasPage />;
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background text-foreground">

      {/* ─── Layer 0: Canvas (always full viewport) ─── */}
      <div className="absolute inset-0">
        <BrainCanvas />
      </div>

      {/* One-time hint after onboarding */}
      <CanvasHint />

      {/* ─── Layer 1: Top Bar (40px) ─── */}
      <div
        className="absolute top-0 right-0 left-0 z-30 h-10"
        style={{
          background: "var(--glass-bg)",
          backdropFilter: "blur(24px) saturate(1.1)",
          borderBottom: "1px solid oklch(0.30 0.007 275 / 0.3)",
        }}
      >
        <TopBar layoutMode={layoutMode} />
      </div>

      {/* ─── Layer 1.5: Connection banner ─── */}
      <ConnectionBanner />

      {/* ─── Layer 2: Dim overlay for slide-over panel ─── */}
      {activePanel && (
        <div
          className="absolute inset-0 z-20 bg-background/40 backdrop-blur-[2px]"
          style={{ top: 40 }}
          onClick={closePanel}
        />
      )}

      {/* ─── Layer 3: Slide-over panel ─── */}
      {activePanel && meta && (
        <div className="absolute inset-0 top-10 z-30 md:right-auto md:left-0">
          <SlideOverPanel
            title={meta.title}
            subtitle={meta.subtitle}
            info={meta.info}
            width={meta.width}
            onClose={closePanel}
          >
            <PanelContent panel={activePanel} />
          </SlideOverPanel>
        </div>
      )}

      {/* ─── Layer 4: Chat Drawer ─── */}
      <ChatPanel
        collapsed={chatCollapsed}
        layoutMode={layoutMode}
      />

      {/* ─── Layer 5: Expand FAB ─── */}
      <div
        className={cn(
          "absolute z-30 transition-all duration-300",
          isExpanded
            ? "bottom-4 right-4"
            : chatCollapsed
              ? "bottom-5 right-4 md:right-16"
              : "bottom-5 hidden md:block md:right-[474px]"
        )}
      >
        <ExpandFab />
      </div>

      {/* ─── Mobile navigation menu ─── */}
      <MobileMenu />

      {/* ─── PC Viewer overlay ─── */}
      <PcViewer />

      {/* ─── Full-screen Settings overlay ─── */}
      <SettingsOverlay />

      {/* ─── Expand mode hint ─── */}
      {isExpanded && (
        <div className="animate-hint-fade pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
          <span className="rounded-lg bg-card/80 px-3 py-1.5 font-mono text-[10px] text-muted-foreground backdrop-blur-sm">
            Press <kbd className="mx-0.5 rounded bg-muted px-1.5 py-0.5 text-foreground">ESC</kbd> to exit
          </span>
        </div>
      )}
    </div>
  );
}
