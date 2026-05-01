export const SESSION_PINS_CHANGED_EVENT = "chvor:session-pins-changed";

export type SessionPinsChangedReason = "pin-session" | "unpin" | "clear-all" | "external";

export interface SessionPinsChangedDetail {
  reason?: SessionPinsChangedReason;
}

const DEFAULT_REFRESH_DELAYS = [0] as const;
const PIN_SESSION_REFRESH_DELAYS = [0, 300, 1000] as const;

export function getSessionPinRefreshDelays(reason?: SessionPinsChangedReason): readonly number[] {
  return reason === "pin-session" ? PIN_SESSION_REFRESH_DELAYS : DEFAULT_REFRESH_DELAYS;
}

export function readSessionPinsChangedDetail(event: Event): SessionPinsChangedDetail {
  return event instanceof CustomEvent
    ? ((event.detail as SessionPinsChangedDetail | undefined) ?? {})
    : {};
}

export function notifySessionPinsChanged(detail: SessionPinsChangedDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SessionPinsChangedDetail>(SESSION_PINS_CHANGED_EVENT, { detail })
  );
}
