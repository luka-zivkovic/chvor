import { describe, expect, it, vi } from "vitest";
import { Gateway } from "../../gateway/gateway.ts";

describe("gateway abort acknowledgement", () => {
  it("acknowledges stop immediately without waiting for engine settlement", () => {
    const gateway = new Gateway();
    const controller = new AbortController();
    const acknowledge = vi.fn();
    const internals = gateway as unknown as {
      sessionAbortControllers: Map<string, AbortController>;
      sessionStopAcknowledgers: Map<string, () => void>;
    };
    internals.sessionAbortControllers.set("web:session:default", controller);
    internals.sessionStopAcknowledgers.set("web:session:default", acknowledge);

    expect(gateway.abortSession("web:session:default")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
