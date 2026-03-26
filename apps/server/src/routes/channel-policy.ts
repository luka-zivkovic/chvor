import { Hono } from "hono";
import type { ChannelType, UpdateChannelPolicyRequest, ChannelPolicyDmMode, ChannelPolicyGroupMode } from "@chvor/shared";
import { getChannelPolicy, updateChannelPolicy } from "../db/config-store.ts";

const VALID_DM_MODES: ChannelPolicyDmMode[] = ["open", "allowlist", "disabled"];
const VALID_GROUP_MODES: ChannelPolicyGroupMode[] = ["open", "allowlist", "disabled"];
const VALID_CHANNEL_TYPES: string[] = ["whatsapp"];
const PHONE_RE = /^\d{7,15}$/;

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
    for (const num of body.dm?.allowlist ?? []) {
      if (!PHONE_RE.test(num)) return c.json({ error: `Invalid phone number in dm.allowlist: ${num}` }, 400);
    }
    for (const num of body.groupSenderFilter?.allowlist ?? []) {
      if (!PHONE_RE.test(num)) return c.json({ error: `Invalid phone number in groupSenderFilter.allowlist: ${num}` }, 400);
    }

    const updated = updateChannelPolicy(channelType as ChannelType, body);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default channelPolicy;
