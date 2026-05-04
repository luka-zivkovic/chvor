import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseA2UIAction, type ParsedA2UIAction } from "@chvor/shared";
import { a2uiActionKey, useRuntimeStore, type A2UIActionState } from "../../stores/runtime-store";

/**
 * A2UI action sandbox.
 *
 * Server-driven surfaces ship arbitrary action strings on Button + Form. The
 * renderer never honors them directly — it parses through `parseA2UIAction`
 * and dispatches only allowlisted shapes (navigate / emit / noop) through
 * this context. Hosts register what each navigate/emit target actually does.
 *
 * Anything off the allowlist (raw URLs, javascript:, data:, etc.) is logged
 * and dropped — the button/form silently no-ops rather than firing the action.
 */

export type A2UIActionDispatcher = (
  action: ParsedA2UIAction,
  sourceId?: string
) => void | Promise<void>;

interface A2UIActionContextValue {
  surfaceId: string;
  dispatch: A2UIActionDispatcher;
}

const A2UIActionContext = createContext<A2UIActionContextValue | null>(null);

export function A2UIActionProvider({
  surfaceId,
  dispatch,
  children,
}: {
  surfaceId: string;
  dispatch: A2UIActionDispatcher;
  children: ReactNode;
}) {
  // Memoize so consumers don't re-render on every parent render.
  const value = useMemo(() => ({ surfaceId, dispatch }), [dispatch, surfaceId]);
  return <A2UIActionContext.Provider value={value}>{children}</A2UIActionContext.Provider>;
}

export function useA2UIAction(sourceId?: string): {
  /** Parse + dispatch a raw action string. Returns true if dispatched. */
  fire: (raw: string, sourceId?: string) => Promise<boolean>;
  /** True if a host dispatcher is registered (controls UI affordances). */
  enabled: boolean;
  /** Last known queued/running/completed daemon task for this source component. */
  state: A2UIActionState | null;
} {
  const context = useContext(A2UIActionContext);
  const stateKey = context && sourceId ? a2uiActionKey(context.surfaceId, sourceId) : null;
  const state = useRuntimeStore((s) => (stateKey ? (s.a2uiActionStates[stateKey] ?? null) : null));
  return {
    enabled: context !== null,
    state,
    fire: async (raw: string, sourceId?: string): Promise<boolean> => {
      const parsed = parseA2UIAction(raw);
      if (!parsed) {
        console.warn(`[a2ui] dropped unsafe action${sourceId ? ` on "${sourceId}"` : ""}:`, raw);
        return false;
      }
      if (!context) {
        console.warn(`[a2ui] no dispatcher registered — dropping ${parsed.kind} action`);
        return false;
      }
      try {
        await context.dispatch(parsed, sourceId);
      } catch (err) {
        console.error(`[a2ui] dispatcher threw on action${sourceId ? ` "${sourceId}"` : ""}:`, err);
        return false;
      }
      return true;
    },
  };
}
