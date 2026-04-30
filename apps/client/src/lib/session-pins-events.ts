export const SESSION_PINS_CHANGED_EVENT = "chvor:session-pins-changed";

export function notifySessionPinsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_PINS_CHANGED_EVENT));
}
