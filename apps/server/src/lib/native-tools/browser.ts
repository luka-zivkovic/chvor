import { tool } from "ai";
import { z } from "zod";
import { logError } from "../error-logger.ts";
import { validateFetchUrl } from "./security.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

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
    "[Web Agent] Navigate to a URL. Use this as the first step when browsing the web. Returns the page title and final URL.",
  parameters: z.object({
    url: z.string().describe("The URL to navigate to (e.g. 'https://google.com')"),
  }),
});

const handleBrowserNavigate: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const sessionId = requireSessionId(context);
  const rawUrl = String(args.url);

  // SSRF protection: validate URL before navigating (same rules as http_fetch)
  try {
    await validateFetchUrl(rawUrl);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Browser navigate blocked: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  try {
    const { getBrowser } = await import("../browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    await withTimeout(
      stagehand.page.goto(rawUrl, { waitUntil: "domcontentloaded" }),
      BROWSER_OP_TIMEOUT,
      "Navigation",
    );
    const title = await stagehand.page.title();
    const url = stagehand.page.url();
    return {
      content: [{ type: "text", text: `Navigated to: ${url}\nPage title: ${title}` }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser navigate failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
};

const browserActToolDef = tool({
  description:
    "[Web Agent] Perform an action on the current page using natural language. Examples: 'click the Sign In button', 'type hello@example.com in the email field', 'scroll down', 'select the second item from the dropdown'.",
  parameters: z.object({
    instruction: z
      .string()
      .describe("Natural language instruction for the action to perform"),
  }),
});

const handleBrowserAct: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const sessionId = requireSessionId(context);
  try {
    const { getBrowser } = await import("../browser-manager.ts");
    const stagehand = await getBrowser(sessionId);
    const result = await withTimeout(
      stagehand.page.act(String(args.instruction)),
      BROWSER_OP_TIMEOUT,
      "Action",
    );
    return {
      content: [{ type: "text", text: result ? `Action completed: ${JSON.stringify(result)}` : "Action completed successfully." }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser action failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
};

const browserExtractToolDef = tool({
  description:
    "[Web Agent] Extract structured data from the current page. Describe what data you want and the AI will find and extract it. Example: 'get all product names and prices', 'extract the main article text'.",
  parameters: z.object({
    instruction: z
      .string()
      .describe("What data to extract from the current page"),
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
      "Extract",
    );
    let text: string;
    try {
      text = typeof result === "string" ? result : JSON.stringify(result);
    } catch {
      text = "[Extract returned non-serializable data]";
    }
    return {
      content: [{ type: "text", text: text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[...truncated]" : text }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser extract failed: ${err instanceof Error ? err.message : String(err)}` }],
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
      .describe("Optional: what to look for (e.g. 'find login form elements'). If omitted, returns all visible interactive elements."),
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
      "Observe",
    );
    let text: string;
    try {
      text = JSON.stringify(observations);
    } catch {
      text = "[Observe returned non-serializable data]";
    }
    return {
      content: [{ type: "text", text: text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[...truncated]" : text }],
    };
  } catch (err) {
    await evictIfBrowserDead(err, sessionId);
    return {
      content: [{ type: "text", text: `Browser observe failed: ${err instanceof Error ? err.message : String(err)}` }],
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
