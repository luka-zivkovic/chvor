import { tool } from "ai";
import { z } from "zod";
import { logError } from "../error-logger.ts";
import { validateFetchUrl } from "./security.ts";
import {
  extractSecretValues,
  hasCredentialPlaceholder,
  injectPlaceholders,
  parseCredRef,
  PLACEHOLDER_RE,
  redactKnownSecrets,
  withSecretSeal,
} from "../credential-injector.ts";
import { pickCredential, type PickResult } from "../credential-picker.ts";
import { getCredentialData } from "../../db/credential-store.ts";
import type {
  NativeToolContext,
  NativeToolHandler,
  NativeToolModule,
  NativeToolResult,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Browser Agent tools
// ---------------------------------------------------------------------------
// Lazy import to avoid loading Stagehand (and Playwright) at startup.
// The browser-manager module handles session lifecycle.

const BROWSER_NAVIGATE_NAME = "native__browser_navigate";
const BROWSER_ACT_NAME = "native__browser_act";
const BROWSER_EXTRACT_NAME = "native__browser_extract";
const BROWSER_OBSERVE_NAME = "native__browser_observe";
const BROWSER_OP_TIMEOUT = 60_000; // 60 seconds

function requireSessionId(context?: NativeToolContext): string {
  const id = context?.sessionId;
  if (!id) {
    console.warn("[browser-tools] missing sessionId in context, using 'default'");
  }
  return id ?? "default";
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Check if an error indicates the browser session is dead and evict it. */
async function evictIfBrowserDead(err: unknown, sessionId: string): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const deadPatterns = [
    "Target closed",
    "Browser has been closed",
    "browser has disconnected",
    "Session closed",
    "Execution context was destroyed",
    "timed out",
  ];
  if (deadPatterns.some((p) => msg.includes(p))) {
    console.warn(`[browser-tools] evicting dead session ${sessionId}: ${msg}`);
    logError("browser_error", err, { sessionId, evicted: true });
    const { closeBrowser } = await import("../browser-manager.ts");
    await closeBrowser(sessionId).catch(() => {});
  }
}

const browserNavigateToolDef = tool({
  description:
    "[Web Agent] Navigate to a URL. Use this as the first step when browsing the web. Returns the page title and final URL. " +
    "If a URL needs to embed a credential (e.g. a token query param), reference it with `{{credentials.<type>}}` or, when multiple credentials share a type, the safer `{{credentials.<credentialId>}}` — the value is URL-encoded and substituted at the browser boundary; the recorded URL keeps the placeholder.",
  parameters: z.object({
    url: z
      .string()
      .describe(
        "The URL to navigate to (e.g. 'https://google.com'). May contain {{credentials.<type>}} or {{credentials.<credentialId>}} placeholders for tokens that must appear in the URL."
      ),
  }),
});

const handleBrowserNavigate: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const sessionId = requireSessionId(context);
  const rawUrl = String(args.url);

  let expanded: string;
  let secretsToSeal: string[];
  let picks: BrowserCredentialPick[] = [];
  try {
    ({ expanded, secretsToSeal, picks } = await expandBrowserCredentialsInteractive(
      rawUrl,
      sessionId,
      {
        urlEncode: true,
        allowedCredentialTypes: context?.allowedCredentialTypes,
        preferredUsageContext: context?.preferredUsageContext,
        originClientId: context?.originClientId,
        toolName: BROWSER_NAVIGATE_NAME,
      }
    ));
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }

  // SSRF protection: validate URL after expansion (same rules as http_fetch).
  // Keep the seal open while formatting any validation error in case a future
  // validator includes the expanded URL in its message.
  let blockedMessage: string | null = null;
  await withSecretSeal(secretsToSeal, async () => {
    try {
      await validateFetchUrl(expanded);
    } catch (err) {
      blockedMessage = redactKnownSecrets(err instanceof Error ? err.message : String(err));
    }
  });
  if (blockedMessage) {
    return {
      content: [
        {
          type: "text",
          text: `Browser navigate blocked: ${blockedMessage}`,
        },
      ],
    };
  }
  emitCredentialPicks(context, picks);

  return withSecretSeal(secretsToSeal, async () => {
    try {
      const { getBrowser } = await import("../browser-manager.ts");
      const stagehand = await getBrowser(sessionId);
      await withTimeout(
        stagehand.page.goto(expanded, { waitUntil: "domcontentloaded" }),
        BROWSER_OP_TIMEOUT,
        "Navigation"
      );
      const title = await stagehand.page.title();
      const url = stagehand.page.url();
      return {
        content: [
          { type: "text", text: redactKnownSecrets(`Navigated to: ${url}\nPage title: ${title}`) },
        ],
      };
    } catch (err) {
      await evictIfBrowserDead(err, sessionId);
      const message = redactKnownSecrets(err instanceof Error ? err.message : String(err));
      return {
        content: [
          {
            type: "text",
            text: `Browser navigate failed: ${message}`,
          },
        ],
      };
    }
  });
};

const browserActToolDef = tool({
  description:
    "[Web Agent] Perform an action on the current page using natural language. Examples: 'click the Sign In button', 'type {{credentials.github}} in the password field', 'scroll down', 'select the second item from the dropdown'. " +
    "For credentials: ALWAYS reference them with `{{credentials.<type>}}` or, when multiple credentials share a type, the safer `{{credentials.<credentialId>}}` placeholders — never paste raw passwords or tokens. The placeholder is expanded at the browser boundary so secret values never reach the chat history. " +
    "✓ Good: `type {{credentials.github}} in the password field`. " +
    "✗ Bad: `type ghp_abc123xyz... in the password field`.",
  parameters: z.object({
    instruction: z
      .string()
      .describe(
        "Natural language instruction. Use {{credentials.<type>}} or {{credentials.<credentialId>}} placeholders for any password/token; never inline raw secret values."
      ),
  }),
});

/**
 * Phase E2 — expand `{{credentials.<type>[.field]}}` placeholders in a
 * browser-tool argument (instruction or URL) at the very last moment before
 * it reaches Stagehand / Playwright.
 *
 * Returns:
 *   - `expanded`: the placeholder-substituted string handed to the boundary
 *     API. Held for the lifetime of the call only.
 *   - `secretsToSeal`: raw values to register with `withSecretSeal` so any
 *     downstream logging that does see the expanded value gets scrubbed.
 *   - `expandedTypes`: the credential types that were substituted, used to
 *     surface a non-secret note in the tool's text result.
 *
 * The original (placeholder) string is what the orchestrator records in
 * `ActionEvent.args`, so the persisted row never contains the raw secret.
 */
// UUID-shaped ids are accepted on the byRef path; anything else is treated as
// a credential type so a credential whose leading segment collides with a
// known type cannot bypass the type picker (and skill scope) by id-match.
const CREDENTIAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BrowserCredentialPick {
  credentialType: string;
  credentialId: string;
  credentialName: string;
  reason: PickResult["reason"];
  pickedBy: PickResult["reason"];
  candidateCount: number;
  detail?: string;
}

export interface BrowserCredentialExpansion {
  expanded: string;
  secretsToSeal: string[];
  expandedTypes: string[];
  picks: BrowserCredentialPick[];
}

interface BrowserCredentialSelection {
  ref: string;
  type: string;
  data: Record<string, string>;
  pick: BrowserCredentialPick;
}

interface BrowserCredentialExpansionOptions {
  urlEncode?: boolean;
  allowedCredentialTypes?: string[];
  preferredUsageContext?: string[];
}

interface InteractiveBrowserCredentialExpansionOptions extends BrowserCredentialExpansionOptions {
  originClientId?: string;
  toolName?: string;
}

function credentialRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    refs.add(parseCredRef(m[1]).type);
  }
  return refs;
}

function allowedTypesSet(allowedCredentialTypes?: string[]): Set<string> | null {
  return allowedCredentialTypes && allowedCredentialTypes.length > 0
    ? new Set(allowedCredentialTypes)
    : null;
}

function assertAllowedType(credType: string, allowedTypes: Set<string> | null): void {
  if (allowedTypes && !allowedTypes.has(credType)) {
    throw new Error(
      `[browser_tools] credential type "${credType}" is not allowed by the active skill scope`
    );
  }
}

function directIdSelection(
  ref: string,
  allowedTypes: Set<string> | null
): BrowserCredentialSelection | null {
  if (!CREDENTIAL_ID_RE.test(ref)) return null;
  const byId = getCredentialData(ref);
  if (!byId) return null;
  assertAllowedType(byId.cred.type, allowedTypes);
  return {
    ref,
    type: byId.cred.type,
    data: byId.data,
    pick: {
      credentialType: byId.cred.type,
      credentialId: byId.cred.id,
      credentialName: byId.cred.name,
      reason: "llm-picked",
      pickedBy: "llm-picked",
      candidateCount: 1,
      detail: `placeholder referenced credential id "${byId.cred.name}"`,
    },
  };
}

function buildPickEvent(
  credType: string,
  pick: PickResult,
  credentialName: string
): BrowserCredentialPick {
  return {
    credentialType: credType,
    credentialId: pick.credentialId,
    credentialName,
    reason: pick.reason,
    pickedBy: pick.reason,
    candidateCount: pick.candidateCount,
    detail: pick.detail,
  };
}

function ambiguousCredentialMessage(credType: string): string {
  return (
    `[browser_tools] multiple "${credType}" credentials are available and no pin or context ` +
    `selected a clear winner. Use a specific {{credentials.<credentialId>[.field]}} placeholder ` +
    `or pin a "${credType}" credential for this session before using browser credentials.`
  );
}

function buildExpansion(
  text: string,
  selections: BrowserCredentialSelection[],
  urlEncode?: boolean
): BrowserCredentialExpansion {
  const byType = new Map<string, Record<string, string>>();
  const byRef = new Map<string, Record<string, string>>();
  const seal: string[] = [];
  const expandedTypes: string[] = [];
  const picks: BrowserCredentialPick[] = [];

  for (const selection of selections) {
    byType.set(selection.type, selection.data);
    byRef.set(selection.ref, selection.data);
    // Type placeholders are also keyed in byRef for exact field-preserving
    // substitution (`{{credentials.github.apiKey}}`).
    byRef.set(selection.type, selection.data);
    seal.push(...extractSecretValues(selection.data));
    expandedTypes.push(selection.type);
    picks.push(selection.pick);
  }

  return {
    expanded: injectPlaceholders(text, { byRef, byType, urlEncode }),
    secretsToSeal: seal,
    expandedTypes: Array.from(new Set(expandedTypes)),
    picks,
  };
}

function syncTypeSelection(
  ref: string,
  sessionId: string,
  opts: BrowserCredentialExpansionOptions,
  allowedTypes: Set<string> | null
): BrowserCredentialSelection {
  const credType = ref;
  assertAllowedType(credType, allowedTypes);
  const pick = pickCredential(credType, {
    sessionId,
    allowedCredentialTypes: opts.allowedCredentialTypes,
    preferredUsageContext: opts.preferredUsageContext,
  });
  if (!pick) {
    throw new Error(
      `[browser_tools] no credential of type or id "${credType}" available — add one in Settings > Credentials before referencing it`
    );
  }
  if (pick.reason === "first-match-fallback" && pick.candidateCount > 1) {
    throw new Error(ambiguousCredentialMessage(credType));
  }
  const full = getCredentialData(pick.credentialId);
  if (!full) {
    throw new Error(`[browser_tools] credential ${pick.credentialId} could not be decrypted`);
  }
  return {
    ref,
    type: credType,
    data: full.data,
    pick: buildPickEvent(credType, pick, full.cred.name),
  };
}

export function expandBrowserCredentials(
  text: string,
  sessionId: string,
  opts: BrowserCredentialExpansionOptions = {}
): BrowserCredentialExpansion {
  if (!hasCredentialPlaceholder(text)) {
    return { expanded: text, secretsToSeal: [], expandedTypes: [], picks: [] };
  }
  // Pull every `{{credentials.<type-or-id>[.field]}}` into maps. A ref whose
  // leading segment looks like a credential id is resolved directly; otherwise
  // we keep the Phase E type picker path. The id-shape gate stops a credential
  // whose id happens to collide with a registered type literal from bypassing
  // the picker (and skill-scope check).
  const refs = credentialRefs(text);
  const allowedTypes = allowedTypesSet(opts.allowedCredentialTypes);
  const selections: BrowserCredentialSelection[] = [];
  for (const ref of refs) {
    const byId = directIdSelection(ref, allowedTypes);
    selections.push(byId ?? syncTypeSelection(ref, sessionId, opts, allowedTypes));
  }
  return buildExpansion(text, selections, opts.urlEncode);
}

async function interactiveTypeSelection(
  ref: string,
  sessionId: string,
  opts: InteractiveBrowserCredentialExpansionOptions,
  allowedTypes: Set<string> | null
): Promise<BrowserCredentialSelection> {
  const credType = ref;
  assertAllowedType(credType, allowedTypes);
  const pick = pickCredential(credType, {
    sessionId,
    allowedCredentialTypes: opts.allowedCredentialTypes,
    preferredUsageContext: opts.preferredUsageContext,
  });
  if (!pick) {
    throw new Error(
      `[browser_tools] no credential of type or id "${credType}" available — add one in Settings > Credentials before referencing it`
    );
  }

  let resolvedPick = pick;
  if (pick.reason === "first-match-fallback" && pick.candidateCount > 1) {
    if (!opts.originClientId) {
      throw new Error(ambiguousCredentialMessage(credType));
    }
    const { requestCredentialChoice } = await import("../credential-choice.ts");
    const choice = await requestCredentialChoice({
      sessionId,
      originClientId: opts.originClientId,
      credentialType: credType,
      toolName: opts.toolName,
      reason: pick.detail ?? `Multiple ${credType} credentials are available.`,
    });
    if (!choice.ok) {
      throw new Error(
        choice.reason === "cancelled"
          ? `[browser_tools] credential choice for "${credType}" was cancelled`
          : choice.reason === "no-active-ui"
            ? `[browser_tools] cannot prompt for "${credType}" credential choice — no active UI connection`
            : `[browser_tools] credential choice for "${credType}" ${choice.reason}`
      );
    }
    resolvedPick = {
      credentialId: choice.credentialId,
      reason: "user-picked",
      candidateCount: pick.candidateCount,
      detail:
        choice.action === "pin-session"
          ? `user selected and pinned "${choice.credentialName}" for this session`
          : `user selected "${choice.credentialName}" for this browser call`,
    };
  }

  const full = getCredentialData(resolvedPick.credentialId);
  if (!full) {
    throw new Error(
      `[browser_tools] credential ${resolvedPick.credentialId} could not be decrypted`
    );
  }
  return {
    ref,
    type: credType,
    data: full.data,
    pick: buildPickEvent(credType, resolvedPick, full.cred.name),
  };
}

export async function expandBrowserCredentialsInteractive(
  text: string,
  sessionId: string,
  opts: InteractiveBrowserCredentialExpansionOptions = {}
): Promise<BrowserCredentialExpansion> {
  if (!hasCredentialPlaceholder(text)) {
    return { expanded: text, secretsToSeal: [], expandedTypes: [], picks: [] };
  }
  const refs = credentialRefs(text);
  const allowedTypes = allowedTypesSet(opts.allowedCredentialTypes);
  const selections: BrowserCredentialSelection[] = [];
  for (const ref of refs) {
    const byId = directIdSelection(ref, allowedTypes);
    selections.push(byId ?? (await interactiveTypeSelection(ref, sessionId, opts, allowedTypes)));
  }
  return buildExpansion(text, selections, opts.urlEncode);
}

function emitCredentialPicks(
  context: NativeToolContext | undefined,
  picks: BrowserCredentialPick[]
): void {
  if (!context?.emitEvent) return;
  const seen = new Set<string>();
  for (const pick of picks) {
    const key = `${pick.credentialType}:${pick.credentialId}:${pick.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    context.emitEvent({
      type: "credential.resolved",
      data: { ...pick, surface: "native" },
    });
  }
}

const handleBrowserAct: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const sessionId = requireSessionId(context);
  const instruction = String(args.instruction ?? "");
  let expanded: string;
  let secretsToSeal: string[];
  let expandedTypes: string[];
  let picks: BrowserCredentialPick[] = [];
  try {
    ({ expanded, secretsToSeal, expandedTypes, picks } = await expandBrowserCredentialsInteractive(
      instruction,
      sessionId,
      {
        allowedCredentialTypes: context?.allowedCredentialTypes,
        preferredUsageContext: context?.preferredUsageContext,
        originClientId: context?.originClientId,
        toolName: BROWSER_ACT_NAME,
      }
    ));
    emitCredentialPicks(context, picks);
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
  return withSecretSeal(secretsToSeal, async () => {
    try {
      const { getBrowser } = await import("../browser-manager.ts");
      const stagehand = await getBrowser(sessionId);
      const result = await withTimeout(stagehand.page.act(expanded), BROWSER_OP_TIMEOUT, "Action");
      const note =
        expandedTypes.length > 0 ? ` [credentials substituted: ${expandedTypes.join(", ")}]` : "";
      const resultText = result ? redactKnownSecrets(JSON.stringify(result)) : "";
      return {
        content: [
          {
            type: "text",
            text: result
              ? `Action completed: ${resultText}${note}`
              : `Action completed successfully.${note}`,
          },
        ],
      };
    } catch (err) {
      await evictIfBrowserDead(err, sessionId);
      const message = redactKnownSecrets(err instanceof Error ? err.message : String(err));
      return {
        content: [
          {
            type: "text",
            text: `Browser action failed: ${message}`,
          },
        ],
      };
    }
  });
};

const browserExtractToolDef = tool({
  description:
    "[Web Agent] Extract structured data from the current page. Describe what data you want and the AI will find and extract it. Example: 'get all product names and prices', 'extract the main article text'.",
  parameters: z.object({
    instruction: z.string().describe("What data to extract from the current page"),
  }),
});

const handleBrowserExtract: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const sessionId = requireSessionId(context);
  try {
    const { getBrowser } = await import("../browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    const result = await withTimeout(
      stagehand.page.extract({ instruction: String(args.instruction) }),
      BROWSER_OP_TIMEOUT,
      "Extract"
    );
    let text: string;
    try {
      text = typeof result === "string" ? result : JSON.stringify(result);
    } catch {
      text = "[Extract returned non-serializable data]";
    }
    return {
      content: [
        {
          type: "text",
          text: text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[...truncated]" : text,
        },
      ],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [
        {
          type: "text",
          text: `Browser extract failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
};

const browserObserveToolDef = tool({
  description:
    "[Web Agent] Observe the current page to see what actions are available. Optionally focus on specific elements. Returns a list of possible actions. Useful before deciding what to click or interact with.",
  parameters: z.object({
    instruction: z
      .string()
      .optional()
      .describe(
        "Optional: what to look for (e.g. 'find login form elements'). If omitted, returns all visible interactive elements."
      ),
  }),
});

const handleBrowserObserve: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const sessionId = requireSessionId(context);
  try {
    const { getBrowser } = await import("../browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    const instruction = args.instruction ? String(args.instruction) : undefined;
    const observations = await withTimeout(
      stagehand.page.observe(instruction ? { instruction } : {}),
      BROWSER_OP_TIMEOUT,
      "Observe"
    );
    let text: string;
    try {
      text = JSON.stringify(observations);
    } catch {
      text = "[Observe returned non-serializable data]";
    }
    return {
      content: [
        {
          type: "text",
          text: text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[...truncated]" : text,
        },
      ],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [
        {
          type: "text",
          text: `Browser observe failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
};

export const browserModule: NativeToolModule = {
  group: "browser",
  defs: {
    [BROWSER_NAVIGATE_NAME]: browserNavigateToolDef,
    [BROWSER_ACT_NAME]: browserActToolDef,
    [BROWSER_EXTRACT_NAME]: browserExtractToolDef,
    [BROWSER_OBSERVE_NAME]: browserObserveToolDef,
  },
  handlers: {
    [BROWSER_NAVIGATE_NAME]: handleBrowserNavigate,
    [BROWSER_ACT_NAME]: handleBrowserAct,
    [BROWSER_EXTRACT_NAME]: handleBrowserExtract,
    [BROWSER_OBSERVE_NAME]: handleBrowserObserve,
  },
  mappings: {
    [BROWSER_NAVIGATE_NAME]: { kind: "tool", id: "web-agent" },
    [BROWSER_ACT_NAME]: { kind: "tool", id: "web-agent" },
    [BROWSER_EXTRACT_NAME]: { kind: "tool", id: "web-agent" },
    [BROWSER_OBSERVE_NAME]: { kind: "tool", id: "web-agent" },
  },
};
