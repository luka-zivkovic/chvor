import { useCallback } from "react";
import type { A2UISurface, ParsedA2UIAction } from "@chvor/shared";
import { api } from "../../lib/api";
import { useUIStore } from "../../stores/ui-store";
import { useRuntimeStore } from "../../stores/runtime-store";
import { A2UIActionProvider } from "./action-context";
import { A2UIRenderer } from "./A2UIRenderer";

const NAVIGABLE_PANELS = new Set([
  "brain",
  "persona",
  "memory",
  "knowledge",
  "schedules",
  "webhooks",
  "skills",
  "tools",
  "connections",
  "integrations",
  "integration-catalog",
  "conversations",
  "activity",
  "emotion-history",
  "registry",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function A2UIHostRenderer({
  surfaceId,
  surface,
}: {
  surfaceId: string;
  surface: A2UISurface;
}) {
  const openPanel = useUIStore((s) => s.openPanel);
  const handleA2UIActionQueued = useRuntimeStore((s) => s.handleA2UIActionQueued);
  const selectCognitiveLoop = useRuntimeStore((s) => s.selectCognitiveLoop);

  const dispatch = useCallback(
    async (action: ParsedA2UIAction, sourceId?: string) => {
      if (action.kind === "noop") return;
      if (action.kind === "navigate") {
        if (NAVIGABLE_PANELS.has(action.panelId)) {
          openPanel(action.panelId as Parameters<typeof openPanel>[0]);
        }
        return;
      }

      const payload = asRecord(action.payload);
      try {
        const task = await api.a2ui.dispatchAction({
          surfaceId,
          sourceId,
          eventName: action.eventName,
          payload,
        });
        handleA2UIActionQueued({ surfaceId, sourceId, task });
        if (task.loopId) {
          void selectCognitiveLoop(task.loopId);
        }
        void import("sonner")
          .then(({ toast }) => {
            toast.success(`Queued: ${task.title}`);
          })
          .catch(() => {
            /* optional */
          });
      } catch (err) {
        void import("sonner")
          .then(({ toast }) => {
            toast.error(err instanceof Error ? err.message : "Failed to queue action");
          })
          .catch(() => {
            /* optional */
          });
        throw err;
      }
    },
    [handleA2UIActionQueued, openPanel, selectCognitiveLoop, surfaceId]
  );

  return (
    <A2UIActionProvider surfaceId={surfaceId} dispatch={dispatch}>
      <A2UIRenderer surfaceId={surfaceId} surface={surface} />
    </A2UIActionProvider>
  );
}
