import { create } from "zustand";

export type PanelId = "brain" | "persona" | "memory" | "knowledge" | "schedules" | "webhooks" | "skills" | "skill-detail" | "tools" | "tool-detail" | "integration-detail" | "connections" | "integrations" | "conversations" | "activity" | "emotion-history" | "registry";
export type BrainTab = "overview" | "models" | "persona" | "memory";
export type SettingsSection = "permissions" | "connections" | "voice" | "security" | "sessions" | "backup";
export type LayoutMode = "default" | "canvas-expanded" | "canvas";

interface UIState {
  activePanel: PanelId | null;
  brainTab: BrainTab;
  layoutMode: LayoutMode;
  chatCollapsed: boolean;
  /** Mobile navigation drawer */
  mobileMenuOpen: boolean;
  /** Node ID for detail panels (skill-detail, integration-detail) */
  detailNodeId: string | null;
  /** Full-screen settings overlay */
  settingsOpen: boolean;
  /** Which section the settings overlay should open to */
  settingsSection: SettingsSection;
  openPanel: (panel: PanelId) => void;
  closePanel: () => void;
  togglePanel: (panel: PanelId) => void;
  openNodeDetail: (panel: PanelId, nodeId: string) => void;
  setBrainTab: (tab: BrainTab) => void;
  setLayoutMode: (mode: LayoutMode) => void;
  toggleCanvasExpand: () => void;
  toggleChat: () => void;
  toggleMobileMenu: () => void;
  closeMobileMenu: () => void;
  openCanvas: (surfaceId?: string) => void;
  exitCanvas: () => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  activePanel: null,
  brainTab: "overview",
  layoutMode: "default",
  chatCollapsed: false,
  mobileMenuOpen: false,
  detailNodeId: null,
  settingsOpen: false,
  settingsSection: "connections",
  openPanel: (panel) => {
    // Safety net: legacy "settings" panel calls redirect to SettingsOverlay
    if ((panel as string) === "settings") {
      get().openSettings("connections");
      return;
    }
    set({ activePanel: panel, detailNodeId: null });
  },
  closePanel: () => set({ activePanel: null, detailNodeId: null }),
  togglePanel: (panel) =>
    set({ activePanel: get().activePanel === panel ? null : panel, detailNodeId: null }),
  openNodeDetail: (panel, nodeId) => set({ activePanel: panel, detailNodeId: nodeId }),
  setBrainTab: (tab) => set({ brainTab: tab }),
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  toggleCanvasExpand: () => {
    const expanding = get().layoutMode !== "canvas-expanded";
    set({
      layoutMode: expanding ? "canvas-expanded" : "default",
      activePanel: expanding ? null : get().activePanel,
    });
  },
  toggleChat: () => set({ chatCollapsed: !get().chatCollapsed }),
  toggleMobileMenu: () => set({ mobileMenuOpen: !get().mobileMenuOpen }),
  closeMobileMenu: () => set({ mobileMenuOpen: false }),
  openCanvas: (surfaceId?: string) => {
    set({ layoutMode: "canvas", activePanel: null });
    if (surfaceId) {
      import("./a2ui-store").then(({ useA2UIStore }) => {
        useA2UIStore.getState().fetchSurface(surfaceId);
      }).catch((err) => {
        console.error("[ui] failed to load a2ui-store for auto-select:", err);
      });
    }
  },
  exitCanvas: () => set({ layoutMode: "default" }),
  openSettings: (section?: SettingsSection) =>
    set({ settingsOpen: true, activePanel: null, settingsSection: section ?? get().settingsSection }),
  closeSettings: () => set({ settingsOpen: false }),
}));
