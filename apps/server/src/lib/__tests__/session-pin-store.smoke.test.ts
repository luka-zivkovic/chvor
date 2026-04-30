import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "chvor-session-pins-"));
process.env.CHVOR_DATA_DIR = tmp;

let setSessionPin: typeof import("../../db/session-pin-store.ts").setSessionPin;
let getSessionPin: typeof import("../../db/session-pin-store.ts").getSessionPin;
let listSessionPins: typeof import("../../db/session-pin-store.ts").listSessionPins;
let clearSessionPin: typeof import("../../db/session-pin-store.ts").clearSessionPin;
let clearAllSessionPins: typeof import("../../db/session-pin-store.ts").clearAllSessionPins;

beforeAll(async () => {
  ({ setSessionPin, getSessionPin, listSessionPins, clearSessionPin, clearAllSessionPins } =
    await import("../../db/session-pin-store.ts"));
});

beforeEach(() => {
  clearAllSessionPins("sess-pins");
  clearAllSessionPins("other-session");
});

describe("session credential pins", () => {
  it("lists and replaces one pin per credential type", () => {
    setSessionPin("sess-pins", "github", "cred-work");
    setSessionPin("sess-pins", "slack", "cred-slack");
    setSessionPin("sess-pins", "github", "cred-personal");

    expect(getSessionPin("sess-pins", "github")?.credentialId).toBe("cred-personal");
    expect(
      listSessionPins("sess-pins")
        .map((p) => p.credentialType)
        .sort()
    ).toEqual(["github", "slack"]);
  });

  it("clears a single pin without touching the rest of the session", () => {
    setSessionPin("sess-pins", "github", "cred-work");
    setSessionPin("sess-pins", "slack", "cred-slack");

    expect(clearSessionPin("sess-pins", "github")).toBe(true);
    expect(getSessionPin("sess-pins", "github")).toBeNull();
    expect(getSessionPin("sess-pins", "slack")?.credentialId).toBe("cred-slack");
  });

  it("clears all pins for only the requested session", () => {
    setSessionPin("sess-pins", "github", "cred-work");
    setSessionPin("sess-pins", "slack", "cred-slack");
    setSessionPin("other-session", "github", "cred-other");

    expect(clearAllSessionPins("sess-pins")).toBe(2);
    expect(listSessionPins("sess-pins")).toEqual([]);
    expect(getSessionPin("other-session", "github")?.credentialId).toBe("cred-other");
  });
});
