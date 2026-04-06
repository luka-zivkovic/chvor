import { useEffect, useRef, useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import { useUIStore } from "../../stores/ui-store";
import { useScheduleStore } from "../../stores/schedule-store";
import { useWebhookStore } from "../../stores/webhook-store";

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  nodeId: string | null;
  nodeType: string | null;
}

interface MenuItem {
  label: string;
  action: () => void;
}

interface Actions {
  openPanel: (panel: string) => void;
  openNodeDetail: (panel: string, id: string) => void;
  fitView: () => void;
  openSearchDialog: (kind: "skill" | "tool" | null) => void;
}

function getMenuItems(nodeType: string | null, nodeId: string | null, a: Actions): MenuItem[] {
  if (!nodeType) {
    return [
      { label: "Search Registry", action: () => a.openSearchDialog(null) },
      { label: "Browse Templates", action: () => a.openPanel("registry") },
      { label: "Add Skill", action: () => a.openPanel("skills") },
      { label: "Add Tool", action: () => a.openPanel("tools") },
      { label: "Fit View", action: a.fitView },
    ];
  }

  switch (nodeType) {
    case "brain":
      return [
        { label: "Settings", action: () => a.openPanel("brain") },
        { label: "Persona", action: () => a.openPanel("persona") },
      ];
    case "skill":
      return [
        { label: "Edit Skill", action: () => nodeId && a.openNodeDetail("skill-detail", nodeId) },
        { label: "All Skills", action: () => a.openPanel("skills") },
      ];
    case "tool":
      return [
        { label: "Edit Tool", action: () => nodeId && a.openNodeDetail("tool-detail", nodeId) },
        { label: "All Tools", action: () => a.openPanel("tools") },
      ];
    case "skills-hub":
      return [
        { label: "Search Skills", action: () => a.openSearchDialog("skill") },
        { label: "Manage Skills", action: () => a.openPanel("skills") },
      ];
    case "tools-hub":
      return [
        { label: "Search Tools", action: () => a.openSearchDialog("tool") },
        { label: "Manage Tools", action: () => a.openPanel("tools") },
      ];
    case "schedule-hub":
      return [{ label: "Manage Schedules", action: () => a.openPanel("schedules") }];
    case "schedule": {
      const schedId = nodeId?.startsWith("schedule-") ? nodeId.slice("schedule-".length) : null;
      return [
        { label: "Edit Schedule", action: () => { if (schedId) useScheduleStore.getState().selectSchedule(schedId); a.openPanel("schedules"); } },
      ];
    }
    case "webhooks-hub":
      return [{ label: "Manage Webhooks", action: () => a.openPanel("webhooks") }];
    case "webhook": {
      const whId = nodeId?.startsWith("webhook-") ? nodeId.slice("webhook-".length) : null;
      return [
        { label: "Edit Webhook", action: () => { if (whId) useWebhookStore.getState().selectWebhook(whId); a.openPanel("webhooks"); } },
      ];
    }
    case "integrations-hub":
      return [{ label: "Manage Integrations", action: () => a.openPanel("integrations") }];
    case "connections-hub":
      return [{ label: "Manage Connections", action: () => a.openPanel("connections") }];
    case "integration":
      return [{ label: "View Details", action: () => nodeId && a.openNodeDetail("integration-detail", nodeId) }];
    default:
      return [];
  }
}

export function CanvasContextMenu({ menu, onClose, onOpenSearch }: { menu: ContextMenuState; onClose: () => void; onOpenSearch?: (kind: "skill" | "tool" | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!menu.visible) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menu.visible, onClose]);

  useEffect(() => {
    if (!menu.visible) return;
    const handle = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [menu.visible, onClose]);

  if (!menu.visible) return null;

  const close = (fn: () => void) => () => { fn(); onClose(); };
  const items = getMenuItems(menu.nodeType, menu.nodeId, {
    openPanel: (p) => close(() => useUIStore.getState().openPanel(p as any))(),
    openNodeDetail: (p, id) => close(() => useUIStore.getState().openNodeDetail(p as any, id))(),
    fitView: close(() => fitView({ padding: 0.3, duration: 300 })),
    openSearchDialog: (kind) => close(() => onOpenSearch?.(kind))(),
  });

  if (items.length === 0) return null;

  // Clamp position to avoid viewport overflow
  const menuW = 180;
  const menuH = items.length * 32 + 8;
  const x = menu.x + menuW > window.innerWidth ? menu.x - menuW : menu.x;
  const y = menu.y + menuH > window.innerHeight ? menu.y - menuH : menu.y;

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg py-1"
      style={{
        left: x,
        top: y,
        background: "var(--glass-bg-strong)",
        backdropFilter: "blur(20px) saturate(1.1)",
        WebkitBackdropFilter: "blur(20px) saturate(1.1)",
        border: "1px solid var(--glass-border)",
        boxShadow: "0 8px 32px oklch(0 0 0 / 0.5)",
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.action}
          className="flex w-full items-center px-3 py-1.5 text-left font-mono text-[11px] tracking-wide transition-colors duration-100 hover:bg-[var(--glass-bg)]"
          style={{ color: "var(--node-label)" }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
