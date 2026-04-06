import { Hono } from "hono";
import type { ChannelType, UpdateChannelPolicyRequest, ChannelPolicyDmMode, ChannelPolicyGroupMode } from "@chvor/shared";
import { getChannelPolicy, updateChannelPolicy } from "../db/config-store.ts";

const VALID_DM_MODES: ChannelPolicyDmMode[] = ["open", "allowlist", "disabled"];
const VALID_GROUP_MODES: ChannelPolicyGroupMode[] = ["open", "allowlist", "disabled"];
const VALID_CHANNEL_TYPES: string[] = ["whatsapp", "telegram", "discord", "slack", "matrix"];

// Allowlist entry validation per channel type
const ALLOWLIST_VALIDATORS: Record<string, { re: RegExp; label: string }> = {
  whatsapp: { re: /^\d{7,15}$/, label: "phone number" },
  telegram: { re: /^\d{1,20}$/, label: "Telegram user ID (numeric)" },
  discord: { re: /^\d{17,20}$/, label: "Discord user ID (snowflake)" },
  slack: { re: /^[UW][A-Z0-9]{8,}$/i, label: "Slack user ID (U/W-prefixed)" },
  matrix: { re: /^@.+:.+$/, label: "Matrix user ID (@user:server)" },
};

function validateAllowlistEntries(channelType: string, entries: string[]): string | null {
  const validator = ALLOWLIST_VALIDATORS[channelType];
  if (!validator) return null; // no validation for unknown types
  for (const entry of entries) {
    if (!validator.re.test(entry)) {
      return `Invalid ${validator.label} in allowlist: ${entry}`;
    }
  }
  return null;
}

const channelPolicy = new Hono();

channelPolicy.get("/:channelType/policy", (c) => {
  const channelType = c.req.param("channelType");
  if (!VALID_CHANNEL_TYPES.includes(channelType)) {
    return c.json({ error: "Unsupported channel type" }, 400);
  }
  return c.json({ data: getChannelPolicy(channelType as ChannelType) });
});

channelPolicy.patch("/:channelType/policy", async (c) => {
  const channelType = c.req.param("channelType");
  if (!VALID_CHANNEL_TYPES.includes(channelType)) {
    return c.json({ error: "Unsupported channel type" }, 400);
  }
  try {
    const body = (await c.req.json()) as UpdateChannelPolicyRequest;

    if (body.dm?.mode && !VALID_DM_MODES.includes(body.dm.mode)) {
      return c.json({ error: `dm.mode must be one of: ${VALID_DM_MODES.join(", ")}` }, 400);
    }
    if (body.group?.mode && !VALID_GROUP_MODES.includes(body.group.mode)) {
      return c.json({ error: `group.mode must be one of: ${VALID_GROUP_MODES.join(", ")}` }, 400);
    }

    // Validate allowlist entries per channel type
    if (body.dm?.allowlist) {
      const err = validateAllowlistEntries(channelType, body.dm.allowlist);
      if (err) return c.json({ error: err }, 400);
    }
    if (body.groupSenderFilter?.allowlist) {
      const err = validateAllowlistEntries(channelType, body.groupSenderFilter.allowlist);
      if (err) return c.json({ error: err }, 400);
    }
    // Group allowlist for WhatsApp uses JIDs (e.g. 123456@g.us), not phone numbers
    if (body.group?.allowlist && channelType === "whatsapp") {
      for (const entry of body.group.allowlist) {
        if (!entry.endsWith("@g.us") && !/^\d{7,15}$/.test(entry)) {
          return c.json({ error: `Invalid WhatsApp group ID in group.allowlist: ${entry} (expected JID ending in @g.us)` }, 400);
        }
      }
    } else if (body.group?.allowlist) {
      const err = validateAllowlistEntries(channelType, body.group.allowlist);
      if (err) return c.json({ error: err }, 400);
    }

    const updated = updateChannelPolicy(channelType as ChannelType, body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default channelPolicy;
