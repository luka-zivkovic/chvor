import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-credential-leaks-"));
process.env.CHVOR_DATA_DIR = tmp;

let beginAction: typeof import("../event-bus.ts").beginAction;
let finishAction: typeof import("../event-bus.ts").finishAction;
let failAction: typeof import("../event-bus.ts").failAction;
let listTraces: typeof import("../../db/event-store.ts").listTraces;
let withSecretSeal: typeof import("../credential-injector.ts").withSecretSeal;

const SECRET = "ghp_super_secret_regression_value";

beforeAll(async () => {
  ({ beginAction, finishAction, failAction } = await import("../event-bus.ts"));
  ({ listTraces } = await import("../../db/event-store.ts"));
  ({ withSecretSeal } = await import("../credential-injector.ts"));
});

describe("credential leak regressions", () => {
  it("redacts active credential values from persisted action args", async () => {
    let actionId = "";
    await withSecretSeal([SECRET], async () => {
      const handle = beginAction(
        "native",
        "regression__raw_args",
        { token: SECRET, nested: { header: `Bearer ${SECRET}` } },
        { sessionId: "sess-leak-args" }
      );
      actionId = handle.actionId;
      finishAction(handle, { ok: true });
    });

    const trace = listTraces({ sessionId: "sess-leak-args", limit: 5 }).find(
      (t) => t.action.id === actionId
    );
    expect(trace).toBeDefined();
    const stored = JSON.stringify(trace!.action.args);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("«credential»");
  });

  it("redacts active credential values from persisted observation payloads", async () => {
    let actionId = "";
    await withSecretSeal([SECRET], async () => {
      const handle = beginAction(
        "synthesized_call",
        "regression__raw_result",
        { credentialId: "safe-id" },
        { sessionId: "sess-leak-result" }
      );
      actionId = handle.actionId;
      finishAction(handle, {
        text: `upstream echoed ${SECRET}`,
        nested: { authorization: `Bearer ${SECRET}` },
      });
    });

    const trace = listTraces({ sessionId: "sess-leak-result", limit: 5 }).find(
      (t) => t.action.id === actionId
    );
    expect(trace).toBeDefined();
    const stored = JSON.stringify(trace!.observations[0].payload);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("«credential»");
  });

  it("redacts active credential values from persisted error observations", async () => {
    let actionId = "";
    await withSecretSeal([SECRET], async () => {
      const handle = beginAction(
        "mcp_call",
        "regression__raw_error",
        {},
        { sessionId: "sess-leak-error" }
      );
      actionId = handle.actionId;
      failAction(handle, new Error(`tool failed with ${SECRET}`));
    });

    const trace = listTraces({ sessionId: "sess-leak-error", limit: 5 }).find(
      (t) => t.action.id === actionId
    );
    expect(trace).toBeDefined();
    const stored = JSON.stringify(trace!.observations[0].payload);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("«credential»");
  });
});
