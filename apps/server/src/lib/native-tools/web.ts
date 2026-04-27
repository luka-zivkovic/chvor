import { tool } from "ai";
import { z } from "zod";
import { validateFetchUrl } from "./security.ts";
import type { NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// HTTP Fetch tool
// ---------------------------------------------------------------------------
const FETCH_TOOL_NAME = "native__web_request";
const MAX_RESPONSE_LENGTH = 50_000;

/**
 * Read a response body with a byte limit to prevent OOM on large responses.
 * Stops reading once the limit is reached and appends a truncation marker.
 */
async function readResponseBody(response: Response, maxLength: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalLength = 0;
  try {
    while (totalLength < maxLength) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      chunks.push(chunk);
      totalLength += chunk.length;
    }
  } finally {
    if (totalLength >= maxLength) await reader.cancel();
    reader.releaseLock();
  }
  let result = chunks.join("");
  if (result.length > maxLength) {
    result = result.slice(0, maxLength) + "\n\n[...truncated]";
  }
  return result;
}

const fetchToolDef = tool({
  description:
    "[Web Browse] Make HTTP requests to URLs and APIs. Supports GET, POST, PUT, PATCH, DELETE with custom headers and request body.",
  parameters: z.object({
    url: z.string().describe("The URL to fetch"),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .optional()
      .describe("HTTP method (default: GET)"),
    headers: z
      .record(z.string())
      .optional()
      .describe("HTTP headers as key-value pairs"),
    body: z
      .string()
      .optional()
      .describe("Request body (for POST/PUT/PATCH)"),
  }),
});

const handleFetch: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const url = String(args.url);
  const method = String(args.method ?? "GET").toUpperCase();
  const headers = (args.headers ?? {}) as Record<string, string>;
  const body = args.body != null ? String(args.body) : undefined;

  try {
    await validateFetchUrl(url);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Fetch blocked: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";

  const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
  const originHost = new URL(url).host;

  const controller = new AbortController();
  const deadline = Date.now() + 10_000;

  function remainingMs(): number {
    return Math.max(deadline - Date.now(), 0);
  }

  function scheduleAbort(): ReturnType<typeof setTimeout> {
    return setTimeout(() => controller.abort(), remainingMs());
  }

  let timeout = scheduleAbort();

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: hasBody ? body : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    // Handle redirects safely — validate each redirect target against the same blocklist
    const MAX_REDIRECTS = 5;
    let currentResponse = response;
    let currentUrl = url;
    let redirectCount = 0;
    while (currentResponse.status >= 300 && currentResponse.status < 400 && redirectCount < MAX_REDIRECTS) {
      if (remainingMs() <= 0) {
        return { content: [{ type: "text", text: `Fetch timed out during redirect chain (followed ${redirectCount} redirects)` }] };
      }
      const location = currentResponse.headers.get("location");
      if (!location) {
        return { content: [{ type: "text", text: `Redirect with no Location header (HTTP ${currentResponse.status})` }] };
      }
      try {
        const redirectUrl = new URL(location, currentUrl);
        await validateFetchUrl(redirectUrl.href);
        // Strip sensitive headers on cross-origin redirects (browser standard behaviour)
        const isCrossOrigin = redirectUrl.host !== originHost;
        const redirectHeaders = isCrossOrigin
          ? Object.fromEntries(Object.entries(headers).filter(([k]) => !SENSITIVE_HEADERS.has(k.toLowerCase())))
          : headers;
        clearTimeout(timeout);
        timeout = scheduleAbort();
        currentResponse = await fetch(redirectUrl.href, {
          method: "GET",
          headers: redirectHeaders,
          signal: controller.signal,
          redirect: "manual",
        });
        currentUrl = redirectUrl.href;
        redirectCount++;
      } catch (err) {
        return { content: [{ type: "text", text: `Redirect blocked: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
    if (redirectCount >= MAX_REDIRECTS) {
      return { content: [{ type: "text", text: `Too many redirects (followed ${MAX_REDIRECTS})` }] };
    }
    if (redirectCount > 0) {
      clearTimeout(timeout);
      timeout = scheduleAbort();
      const redirectText = await readResponseBody(currentResponse, MAX_RESPONSE_LENGTH);
      return {
        content: [{ type: "text", text: `HTTP ${currentResponse.status} (after ${redirectCount} redirect${redirectCount > 1 ? "s" : ""})\n\n${redirectText}` }],
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    let text: string;

    if (contentType.includes("application/json")) {
      const raw = await readResponseBody(response, MAX_RESPONSE_LENGTH);
      try {
        const json = JSON.parse(raw);
        text = JSON.stringify(json, null, 2);
      } catch {
        text = raw;
      }
    } else {
      text = await readResponseBody(response, MAX_RESPONSE_LENGTH);
    }

    if (text.length > MAX_RESPONSE_LENGTH) {
      text = text.slice(0, MAX_RESPONSE_LENGTH) + "\n\n[...truncated]";
    }

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${response.status} ${response.statusText}\n\n${text}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
    };
  } finally {
    clearTimeout(timeout);
  }
};

// ---------------------------------------------------------------------------
// Web Search tool (zero-config, scrapes DuckDuckGo HTML — no MCP or API key)
// ---------------------------------------------------------------------------
const WEB_SEARCH_TOOL_NAME = "native__web_search";

const webSearchToolDef = tool({
  description:
    "[Web Browse] Search the web for current information. Zero-config default — no API key required. For higher quality results, configure Brave Search or SearXNG in your credentials.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 8)"),
  }),
});

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function extractRealUrl(ddgHref: string): string {
  try {
    const full = ddgHref.startsWith("//") ? "https:" + ddgHref : ddgHref;
    const parsed = new URL(full);
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : full;
  } catch {
    return ddgHref;
  }
}

function parseDuckDuckGoHTML(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Match result links: <a rel="nofollow" class="result__a" href="...">TITLE</a>
  const linkRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Match snippets: <a class="result__snippet" ...>SNIPPET</a>
  const snippetRegex =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ rawHref: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    links.push({ rawHref: match[1], title: stripHtmlTags(match[2]) });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtmlTags(match[1]));
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const url = extractRealUrl(links[i].rawHref);
    // Skip DuckDuckGo internal links (ads, redirects, etc.)
    try { if (new URL(url).hostname.endsWith("duckduckgo.com")) continue; } catch { /* keep non-parseable URLs */ }
    results.push({
      title: links[i].title,
      url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}

// Simple per-process rate limiter for web search (prevents IP bans from DDG)
let lastSearchTimestamp = 0;
const SEARCH_COOLDOWN_MS = 1_000;

const handleWebSearch: NativeToolHandler = async (
  args: Record<string, unknown>
): Promise<NativeToolResult> => {
  const query = String(args.query ?? "");
  const rawMax = Number(args.maxResults ?? 8);
  const maxResults = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(rawMax, 20) : 8;

  if (!query.trim()) {
    return {
      content: [{ type: "text", text: "Error: search query is required." }],
    };
  }

  // Enforce cooldown between searches to avoid hammering DDG
  const now = Date.now();
  const elapsed = now - lastSearchTimestamp;
  if (elapsed < SEARCH_COOLDOWN_MS) {
    await new Promise((r) => setTimeout(r, SEARCH_COOLDOWN_MS - elapsed));
  }
  lastSearchTimestamp = Date.now();

  const searchUrl = "https://html.duckduckgo.com/html/";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Web search failed: HTTP ${response.status} ${response.statusText}`,
          },
        ],
      };
    }

    const html = await response.text();
    const results = parseDuckDuckGoHTML(html, maxResults);

    if (results.length === 0) {
      // Diagnostic: if DDG returned a large HTML body but we parsed 0 results,
      // the HTML structure likely changed — log a warning for operators.
      if (html.length > 5_000) {
        console.warn("[web-search] DuckDuckGo returned HTML (%d bytes) but parser extracted 0 results — HTML structure may have changed", html.length);
      }
      return {
        content: [
          {
            type: "text",
            text: `No results found for "${query}".`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Search results for "${query}":\n\n${formatted}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
};

export const webModule: NativeToolModule = {
  defs: {
    [FETCH_TOOL_NAME]: fetchToolDef,
    [WEB_SEARCH_TOOL_NAME]: webSearchToolDef,
  },
  handlers: {
    [FETCH_TOOL_NAME]: handleFetch,
    [WEB_SEARCH_TOOL_NAME]: handleWebSearch,
  },
  mappings: {
    [FETCH_TOOL_NAME]: { kind: "tool", id: "web-browse" },
    [WEB_SEARCH_TOOL_NAME]: { kind: "tool", id: "web-browse" },
  },
};
