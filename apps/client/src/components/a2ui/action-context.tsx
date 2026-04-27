import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseA2UIAction, type ParsedA2UIAction } from "@chvor/shared";

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

export type A2UIActionDispatcher = (action: ParsedA2UIAction, sourceId?: string) => void;

const A2UIActionContext = createContext<A2UIActionDispatcher | null>(null);

export function A2UIActionProvider({
  dispatch,
  children,
}: {
  dispatch: A2UIActionDispatcher;
  children: ReactNode;
}) {
  // Memoize so consumers don't re-render on every parent render.
  const value = useMemo(() => dispatch, [dispatch]);
  return <A2UIActionContext.Provider value={value}>{children}</A2UIActionContext.Provider>;
}

export function useA2UIAction(): {
  /** Parse + dispatch a raw action string. Returns true if dispatched. */
  fire: (raw: string, sourceId?: string) => boolean;
  /** True if a host dispatcher is registered (controls UI affordances). */
  enabled: boolean;
} {
  const dispatch = useContext(A2UIActionContext);
  return {
    enabled: dispatch !== null,
    fire: (raw: string, sourceId?: string): boolean => {
      const parsed = parseA2UIAction(raw);
      if (!parsed) {
        console.warn(`[a2ui] dropped unsafe action${sourceId ? ` on "${sourceId}"` : ""}:`, raw);
        return false;
      }
      if (!dispatch) {
        console.warn(`[a2ui] no dispatcher registered — dropping ${parsed.kind} action`);
        return false;
      }
      try {
        dispatch(parsed, sourceId);
      } catch (err) {
        console.error(`[a2ui] dispatcher threw on action${sourceId ? ` "${sourceId}"` : ""}:`, err);
        return false;
      }
      return true;
    },
  };
}
