// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  getSessionPinRefreshDelays,
  notifySessionPinsChanged,
  readSessionPinsChangedDetail,
  SESSION_PINS_CHANGED_EVENT,
} from "./session-pins-events";

describe("session-pins-events", () => {
  it("retries refreshes after pin-session changes", () => {
    expect(getSessionPinRefreshDelays("pin-session")).toEqual([0, 300, 1000]);
  });

  it("uses a single immediate refresh for non-pin events", () => {
    expect(getSessionPinRefreshDelays("unpin")).toEqual([0]);
    expect(getSessionPinRefreshDelays("clear-all")).toEqual([0]);
    expect(getSessionPinRefreshDelays()).toEqual([0]);
  });

  it("dispatches custom event details", () => {
    let received: Event | null = null;
    const handler = (event: Event) => {
      received = event;
    };
    window.addEventListener(SESSION_PINS_CHANGED_EVENT, handler, { once: true });

    notifySessionPinsChanged({ reason: "pin-session" });

    expect(received).toBeInstanceOf(CustomEvent);
    expect(readSessionPinsChangedDetail(received!)).toEqual({ reason: "pin-session" });
  });
});
