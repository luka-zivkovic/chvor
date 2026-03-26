import { createHmac, timingSafeEqual } from "node:crypto";
import type { ParsedWebhookEvent, WebhookSource } from "@chvor/shared";

// ── GitHub ──────────────────────────────────────────────

export function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

function parseGitHubPayload(headers: Headers, body: Record<string, unknown>): ParsedWebhookEvent {
  const ghEvent = headers.get("x-github-event") ?? "unknown";
  const action = (body.action as string) ?? "";
  const eventType = action ? `${ghEvent}.${action}` : ghEvent;

  const repo = (body.repository as Record<string, unknown>)?.full_name ?? "unknown";
  const sender = (body.sender as Record<string, unknown>)?.login ?? "unknown";

  let summary: string;
  const details: Record<string, unknown> = { repo, sender, action };

  if (ghEvent === "pull_request" && body.pull_request) {
    const pr = body.pull_request as Record<string, unknown>;
    details.title = pr.title;
    details.number = pr.number;
    details.url = pr.html_url;
    details.branch = (pr.head as Record<string, unknown>)?.ref;
    details.body = typeof pr.body === "string" ? pr.body.slice(0, 500) : "";
    summary = `PR #${pr.number} ${action} by @${sender}: ${pr.title}`;
  } else if (ghEvent === "issues" && body.issue) {
    const issue = body.issue as Record<string, unknown>;
    details.title = issue.title;
    details.number = issue.number;
    details.url = issue.html_url;
    summary = `Issue #${issue.number} ${action} by @${sender}: ${issue.title}`;
  } else if (ghEvent === "push") {
    const commits = (body.commits as unknown[]) ?? [];
    const ref = body.ref as string;
    details.branch = ref?.replace("refs/heads/", "");
    details.commitCount = commits.length;
    summary = `${commits.length} commit(s) pushed to ${details.branch} by @${sender}`;
  } else if (ghEvent === "workflow_run" && body.workflow_run) {
    const wf = body.workflow_run as Record<string, unknown>;
    details.name = wf.name;
    details.conclusion = wf.conclusion;
    details.url = wf.html_url;
    summary = `Workflow "${wf.name}" ${wf.conclusion ?? action} in ${repo}`;
  } else {
    summary = `GitHub event: ${eventType} in ${repo} by @${sender}`;
  }

  return { eventType, summary, details, rawPayload: body };
}

// ── Notion ──────────────────────────────────────────────

function parseNotionPayload(_headers: Headers, body: Record<string, unknown>): ParsedWebhookEvent {
  // Notion sends verification challenges on first setup
  if (body.type === "url_verification") {
    return {
      eventType: "url_verification",
      summary: "Notion verification challenge",
      details: { challenge: body.challenge },
      rawPayload: body,
    };
  }

  const eventType = (body.type as string) ?? "unknown";
  const details: Record<string, unknown> = {};

  // Notion automation webhooks
  if (body.data) {
    const data = body.data as Record<string, unknown>;
    details.data = data;

    // Try to extract page info
    if (data.properties && typeof data.properties === "object") {
      const props = data.properties as Record<string, Record<string, unknown>>;
      const titleProp = Object.values(props).find((p) => p.type === "title");
      if (titleProp && Array.isArray(titleProp.title) && titleProp.title.length > 0) {
        details.title = (titleProp.title[0] as Record<string, unknown>)?.plain_text;
      }
    }
  }

  const title = details.title ? ` "${details.title}"` : "";
  const summary = `Notion event: ${eventType}${title}`;

  return { eventType, summary, details, rawPayload: body };
}

// ── Gmail (Pub/Sub push) ────────────────────────────────

function parseGmailPayload(_headers: Headers, body: Record<string, unknown>): ParsedWebhookEvent {
  const message = body.message as Record<string, unknown> | undefined;
  const details: Record<string, unknown> = {};

  if (message?.data) {
    try {
      const decoded = Buffer.from(message.data as string, "base64").toString("utf-8");
      const data = JSON.parse(decoded) as Record<string, unknown>;
      details.emailAddress = data.emailAddress;
      details.historyId = data.historyId;
    } catch {
      details.rawData = message.data;
    }
  }

  const email = details.emailAddress ?? "unknown";
  const summary = `Gmail notification for ${email} (historyId: ${details.historyId ?? "unknown"})`;

  return {
    eventType: "gmail.notification",
    summary,
    details,
    rawPayload: body,
  };
}

// ── Generic ─────────────────────────────────────────────

export function verifyGenericSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

function parseGenericPayload(headers: Headers, body: unknown): ParsedWebhookEvent {
  const eventType =
    headers.get("x-event-type") ??
    (typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).event as string ??
        (body as Record<string, unknown>).type as string ??
        "unknown"
      : "unknown");

  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const summary = bodyStr.length > 200 ? bodyStr.slice(0, 200) + "..." : bodyStr;
  const details = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)
    : { raw: bodyStr };

  return { eventType, summary, details, rawPayload: body };
}

// ── Dispatcher ──────────────────────────────────────────

export function parseWebhookPayload(
  source: WebhookSource,
  headers: Headers,
  body: unknown
): ParsedWebhookEvent {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  switch (source) {
    case "github":
      return parseGitHubPayload(headers, obj);
    case "notion":
      return parseNotionPayload(headers, obj);
    case "gmail":
      return parseGmailPayload(headers, obj);
    case "generic":
    default:
      return parseGenericPayload(headers, body);
  }
}

// ── Template Rendering ──────────────────────────────────

export function renderTemplate(
  template: string,
  parsed: ParsedWebhookEvent
): string {
  const context: Record<string, unknown> = {
    "event.type": parsed.eventType,
    "event.summary": parsed.summary,
    payload: JSON.stringify(parsed.rawPayload, null, 2)?.slice(0, 4000),
  };

  // Flatten details into event.details.* keys
  for (const [key, value] of Object.entries(parsed.details)) {
    context[`event.details.${key}`] = typeof value === "string" ? value : JSON.stringify(value);
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim();
    return trimmed in context ? String(context[trimmed]) : match;
  });
}
