import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { IntegrationNodeData } from "../../stores/canvas-store";
import { RadiantField } from "./RadiantField";

const INTEGRATION_COLOR = "var(--skill-web)";

/** Extract a likely domain from a credential name, e.g. "Gumroad Access Token" → "gumroad.com" */
function guessDomain(name: string): string | null {
  // Known mappings for services whose domain != first word
  const KNOWN: Record<string, string> = {
    telegram: "telegram.org",
    discord: "discord.com",
    slack: "slack.com",
    whatsapp: "whatsapp.com",
    gumroad: "gumroad.com",
    stripe: "stripe.com",
    notion: "notion.so",
    github: "github.com",
    gitlab: "gitlab.com",
    linear: "linear.app",
    vercel: "vercel.com",
    openai: "openai.com",
    anthropic: "anthropic.com",
    google: "google.com",
    twilio: "twilio.com",
    sendgrid: "sendgrid.com",
    mailgun: "mailgun.com",
    shopify: "shopify.com",
    airtable: "airtable.com",
    supabase: "supabase.com",
    firebase: "firebase.google.com",
    aws: "aws.amazon.com",
    azure: "azure.microsoft.com",
    cloudflare: "cloudflare.com",
    heroku: "heroku.com",
    netlify: "netlify.com",
    reddit: "reddit.com",
    twitter: "twitter.com",
    x: "x.com",
    facebook: "facebook.com",
    instagram: "instagram.com",
    youtube: "youtube.com",
    spotify: "spotify.com",
    dropbox: "dropbox.com",
    trello: "trello.com",
    jira: "atlassian.com",
    confluence: "atlassian.com",
    figma: "figma.com",
    canva: "canva.com",
    zapier: "zapier.com",
    hubspot: "hubspot.com",
    salesforce: "salesforce.com",
    intercom: "intercom.com",
    zendesk: "zendesk.com",
    mailchimp: "mailchimp.com",
    sentry: "sentry.io",
    datadog: "datadoghq.com",
    pagerduty: "pagerduty.com",
    monday: "monday.com",
    asana: "asana.com",
    clickup: "clickup.com",
    todoist: "todoist.com",
    zoom: "zoom.us",
    loom: "loom.com",
    calendly: "calendly.com",
    plaid: "plaid.com",
    paddle: "paddle.com",
    lemonsqueezy: "lemonsqueezy.com",
    resend: "resend.com",
    postmark: "postmarkapp.com",
    neon: "neon.tech",
    planetscale: "planetscale.com",
    upstash: "upstash.com",
    railway: "railway.app",
    render: "render.com",
    fly: "fly.io",
    deno: "deno.com",
    bun: "bun.sh",
    npm: "npmjs.com",
    pypi: "pypi.org",
  };

  const firstWord = name.split(/[\s\-_.:]+/)[0]?.toLowerCase();
  if (!firstWord || firstWord.length < 2) return null;

  if (KNOWN[firstWord]) return KNOWN[firstWord];

  // If name looks like it already contains a domain
  if (name.includes(".")) {
    const domainMatch = name.match(/[\w-]+\.[\w.]+/);
    if (domainMatch) return domainMatch[0];
  }

  return `${firstWord}.com`;
}

function PlugIcon({ color }: { color: string }) {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="M15 9l-6 6" />
      <path d="M9 9h.01" />
      <path d="M15 15h.01" />
    </svg>
  );
}

export const IntegrationNode = memo(function IntegrationNode({ data }: NodeProps) {
  const d = data as unknown as IntegrationNodeData;
  const color = INTEGRATION_COLOR;
  const labelColor = "var(--node-label)";
  const [faviconFailed, setFaviconFailed] = useState(false);

  const domain = guessDomain(d.label);
  const faviconUrl = domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    : null;
  const showFavicon = faviconUrl && !faviconFailed;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
      <div className="group flex flex-col items-center gap-2">
        <div
          className="flex items-center justify-center transition-all duration-300"
          style={{ width: 72, height: 72 }}
        >
          <RadiantField color={color} intensity={0.4}>
            {showFavicon ? (
              <img
                src={faviconUrl}
                alt={d.label}
                width={28}
                height={28}
                className="rounded-sm"
                onError={() => setFaviconFailed(true)}
              />
            ) : (
              <PlugIcon color={color} />
            )}
          </RadiantField>
        </div>
        <span
          className="max-w-[90px] truncate text-center font-mono text-[9px] tracking-wider transition-colors duration-300"
          style={{ color: labelColor }}
        >
          {d.label}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none !w-1.5 !h-1.5 opacity-0" />
    </>
  );
});
