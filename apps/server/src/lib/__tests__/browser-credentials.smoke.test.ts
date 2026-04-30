import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browserMocks = vi.hoisted(() => ({
  act: vi.fn(),
  goto: vi.fn(),
  title: vi.fn(),
  url: vi.fn(),
}));

vi.mock("../browser-manager.ts", () => ({
  getBrowser: vi.fn(async () => ({ page: browserMocks })),
}));

const tmp = mkdtempSync(join(tmpdir(), "chvor-browser-cred-"));
process.env.CHVOR_DATA_DIR = tmp;

let browserModule: typeof import("../native-tools/browser.ts").browserModule;
let expandBrowserCredentials: typeof import("../native-tools/browser.ts").expandBrowserCredentials;
let expandBrowserCredentialsInteractive: typeof import("../native-tools/browser.ts").expandBrowserCredentialsInteractive;
let createCredential: typeof import("../../db/credential-store.ts").createCredential;
let deleteCredential: typeof import("../../db/credential-store.ts").deleteCredential;
let listCredentials: typeof import("../../db/credential-store.ts").listCredentials;
let listPendingCredentialChoices: typeof import("../credential-choice.ts").listPendingCredentialChoices;
let resolveCredentialChoice: typeof import("../credential-choice.ts").resolveCredentialChoice;
let setWSInstance: typeof import("../../gateway/ws-instance.ts").setWSInstance;

beforeAll(async () => {
  ({ browserModule, expandBrowserCredentials, expandBrowserCredentialsInteractive } =
    await import("../native-tools/browser.ts"));
  ({ createCredential, deleteCredential, listCredentials } =
    await import("../../db/credential-store.ts"));
  ({ listPendingCredentialChoices, resolveCredentialChoice } =
    await import("../credential-choice.ts"));
  ({ setWSInstance } = await import("../../gateway/ws-instance.ts"));
  setWSInstance({
    sendTo: () => true,
    getClientsBySessionId: () => ["ws-1"],
    broadcastToSession: () => undefined,
  } as never);
});

afterAll(() => {
  setWSInstance(null);
});

function reset() {
  browserMocks.act.mockReset();
  browserMocks.goto.mockReset();
  browserMocks.title.mockReset();
  browserMocks.url.mockReset();
  for (const c of listCredentials()) deleteCredential(c.id);
}

async function waitForChoice(sessionId: string) {
  for (let i = 0; i < 50; i++) {
    const pending = listPendingCredentialChoices().filter((p) => p.sessionId === sessionId);
    if (pending.length > 0) return pending[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  return listPendingCredentialChoices().find((p) => p.sessionId === sessionId) ?? null;
}

describe("expandBrowserCredentials — skill scope", () => {
  beforeEach(reset);

  it("rejects placeholders for credential types outside allowedCredentialTypes", () => {
    createCredential("Slack", "slack", { token: "xoxb-secret-token" });
    expect(() =>
      expandBrowserCredentials("send {{credentials.slack}} to #x", "sess-1", {
        allowedCredentialTypes: ["github"],
      })
    ).toThrow(/not allowed by the active skill scope/);
  });

  it("rejects byRef placeholders for credentials whose type is outside the scope", () => {
    const slack = createCredential("Slack", "slack", { token: "xoxb-secret-token" });
    expect(() =>
      expandBrowserCredentials(`send {{credentials.${slack.id}}}`, "sess-1", {
        allowedCredentialTypes: ["github"],
      })
    ).toThrow(/not allowed by the active skill scope/);
  });

  it("expands placeholders that are inside the allowed scope", () => {
    createCredential("GitHub", "github", { apiKey: "ghp_secret_value" });
    const out = expandBrowserCredentials("Bearer {{credentials.github}}", "sess-1", {
      allowedCredentialTypes: ["github"],
    });
    expect(out.expanded).toBe("Bearer ghp_secret_value");
    expect(out.expandedTypes).toEqual(["github"]);
    expect(out.secretsToSeal).toContain("ghp_secret_value");
    expect(out.picks[0]).toMatchObject({ reason: "single-match", pickedBy: "single-match" });
    expect(JSON.stringify(out.picks)).not.toContain("ghp_secret_value");
  });
});

describe("expandBrowserCredentials — ambiguous credentials", () => {
  beforeEach(reset);

  it("fails closed instead of silently using first-match fallback in non-interactive expansion", () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work");
    createCredential("Personal GitHub", "github", { apiKey: "ghp_personal" }, "personal");

    expect(() =>
      expandBrowserCredentials("{{credentials.github}}", "sess-1", {
        allowedCredentialTypes: ["github"],
      })
    ).toThrow(/multiple "github" credentials/);
  });

  it("still resolves without prompting when usage context picks a clear winner", () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work enterprise");
    createCredential("Personal GitHub", "github", { apiKey: "ghp_personal" }, "personal");

    const out = expandBrowserCredentials("{{credentials.github}}", "sess-1", {
      allowedCredentialTypes: ["github"],
      preferredUsageContext: ["enterprise"],
    });

    expect(out.expanded).toBe("ghp_work");
    expect(out.picks[0]).toMatchObject({ reason: "context-match", pickedBy: "context-match" });
    expect(JSON.stringify(out.picks)).not.toContain("ghp_work");
  });

  it("rejects with no-active-ui when the origin client cannot receive the choice prompt", async () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work");
    createCredential("Personal GitHub", "github", { apiKey: "ghp_personal" }, "personal");

    setWSInstance({
      sendTo: () => false,
      getClientsBySessionId: () => [],
      broadcastToSession: () => undefined,
    } as never);
    try {
      await expect(
        expandBrowserCredentialsInteractive("{{credentials.github}}", "sess-no-ui", {
          allowedCredentialTypes: ["github"],
          originClientId: "ws-disconnected",
          toolName: "native__browser_act",
        })
      ).rejects.toThrow(/no active UI connection/);
    } finally {
      setWSInstance({
        sendTo: () => true,
        getClientsBySessionId: () => ["ws-1"],
        broadcastToSession: () => undefined,
      } as never);
    }
  });

  it("asks the user for browser placeholder ambiguity in interactive expansion", async () => {
    createCredential("Work GitHub", "github", { apiKey: "ghp_work" }, "work");
    const personal = createCredential(
      "Personal GitHub",
      "github",
      { apiKey: "ghp_personal" },
      "personal"
    );

    const promise = expandBrowserCredentialsInteractive("{{credentials.github}}", "sess-browser", {
      allowedCredentialTypes: ["github"],
      originClientId: "ws-1",
      toolName: "native__browser_act",
    });

    const pending = await waitForChoice("sess-browser");
    expect(pending).toBeTruthy();
    const resolved = resolveCredentialChoice(
      {
        requestId: pending!.requestId,
        action: "use-once",
        credentialId: personal.id,
      },
      "ws-1"
    );
    expect(resolved.ok).toBe(true);

    const out = await promise;
    expect(out.expanded).toBe("ghp_personal");
    expect(out.picks[0]).toMatchObject({
      credentialId: personal.id,
      reason: "user-picked",
      pickedBy: "user-picked",
    });
    expect(JSON.stringify(out.picks)).not.toContain("ghp_personal");
  });
});

describe("browser credential boundary leak regressions", () => {
  beforeEach(reset);

  it("redacts expanded credential values from browser action results", async () => {
    createCredential("GitHub", "github", { apiKey: "ghp_secret_value" });
    browserMocks.act.mockResolvedValue({ echoedInstruction: "type ghp_secret_value" });

    const result = await browserModule.handlers.native__browser_act(
      { instruction: "type {{credentials.github}}" },
      { sessionId: "sess-browser-redact", allowedCredentialTypes: ["github"] }
    );
    const out = JSON.stringify(result);

    expect(browserMocks.act).toHaveBeenCalledWith("type ghp_secret_value");
    expect(out).not.toContain("ghp_secret_value");
    expect(out).toContain("«credential»");
  });

  it("redacts expanded credential values from browser action errors", async () => {
    createCredential("GitHub", "github", { apiKey: "ghp_secret_value" });
    browserMocks.act.mockRejectedValue(new Error("Stagehand saw ghp_secret_value"));

    const result = await browserModule.handlers.native__browser_act(
      { instruction: "type {{credentials.github}}" },
      { sessionId: "sess-browser-redact-error", allowedCredentialTypes: ["github"] }
    );
    const out = JSON.stringify(result);

    expect(out).toContain("Browser action failed");
    expect(out).not.toContain("ghp_secret_value");
    expect(out).toContain("«credential»");
  });
});
