import type {
  ChannelPolicy,
  UpdateChannelPolicyRequest,
  ChannelType,
  SessionLifecycleConfig,
  UpdateSessionLifecycleRequest,
  SessionResetPolicy,
  ChatType,
} from "@chvor/shared";
import { getConfig, setConfig } from "./base.ts";

// --- Channel policy (access control) ---

// Default policy is deny-by-default (allowlist with empty list) for external channels.
// The web channel always bypasses policy checks so this only affects Telegram/Discord/Slack/WhatsApp/Matrix.
const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  dm: { mode: "allowlist", allowlist: [] },
  group: { mode: "allowlist", allowlist: [] },
  groupSenderFilter: { enabled: false, allowlist: [] },
};

export function getChannelPolicy(channelType: ChannelType): ChannelPolicy {
  const raw = getConfig(`channel.${channelType}.policy`);
  if (!raw) return structuredClone(DEFAULT_CHANNEL_POLICY);
  try {
    const parsed = JSON.parse(raw);
    return {
      dm: { ...DEFAULT_CHANNEL_POLICY.dm, ...parsed.dm },
      group: { ...DEFAULT_CHANNEL_POLICY.group, ...parsed.group },
      groupSenderFilter: { ...DEFAULT_CHANNEL_POLICY.groupSenderFilter, ...parsed.groupSenderFilter },
    };
  } catch {
    return structuredClone(DEFAULT_CHANNEL_POLICY);
  }
}

export function updateChannelPolicy(
  channelType: ChannelType,
  updates: UpdateChannelPolicyRequest
): ChannelPolicy {
  const current = getChannelPolicy(channelType);
  if (updates.dm) {
    if (updates.dm.mode !== undefined) current.dm.mode = updates.dm.mode;
    if (updates.dm.allowlist !== undefined) current.dm.allowlist = updates.dm.allowlist;
  }
  if (updates.group) {
    if (updates.group.mode !== undefined) current.group.mode = updates.group.mode;
    if (updates.group.allowlist !== undefined) current.group.allowlist = updates.group.allowlist;
  }
  if (updates.groupSenderFilter) {
    if (updates.groupSenderFilter.enabled !== undefined)
      current.groupSenderFilter.enabled = updates.groupSenderFilter.enabled;
    if (updates.groupSenderFilter.allowlist !== undefined)
      current.groupSenderFilter.allowlist = updates.groupSenderFilter.allowlist;
  }
  setConfig(`channel.${channelType}.policy`, JSON.stringify(current));
  return current;
}

// --- Session lifecycle config ---

const DEFAULT_RESET_POLICY: SessionResetPolicy = {
  idleTimeoutMinutes: 0,
  dailyResetHour: null,
  maxMessages: 0,
};

const DEFAULT_LIFECYCLE_CONFIG: SessionLifecycleConfig = {
  defaultPolicy: { ...DEFAULT_RESET_POLICY },
  chatTypePolicies: {},
  resetTriggers: ["/new", "/reset"],
};

export function getSessionLifecycleConfig(): SessionLifecycleConfig {
  const raw = getConfig("session.lifecycle");
  if (!raw) return structuredClone(DEFAULT_LIFECYCLE_CONFIG);
  try {
    const parsed = JSON.parse(raw);
    return {
      defaultPolicy: { ...DEFAULT_RESET_POLICY, ...parsed.defaultPolicy },
      chatTypePolicies: parsed.chatTypePolicies ?? {},
      resetTriggers: Array.isArray(parsed.resetTriggers) ? parsed.resetTriggers : DEFAULT_LIFECYCLE_CONFIG.resetTriggers,
    };
  } catch {
    return structuredClone(DEFAULT_LIFECYCLE_CONFIG);
  }
}

export function updateSessionLifecycleConfig(
  updates: UpdateSessionLifecycleRequest
): SessionLifecycleConfig {
  const current = getSessionLifecycleConfig();

  if (updates.defaultPolicy) {
    if (updates.defaultPolicy.idleTimeoutMinutes !== undefined) {
      current.defaultPolicy.idleTimeoutMinutes = Math.max(0, Math.floor(updates.defaultPolicy.idleTimeoutMinutes));
    }
    if (updates.defaultPolicy.dailyResetHour !== undefined) {
      const h = updates.defaultPolicy.dailyResetHour;
      current.defaultPolicy.dailyResetHour = h === null ? null : Math.max(0, Math.min(23, Math.floor(h)));
    }
    if (updates.defaultPolicy.maxMessages !== undefined) {
      current.defaultPolicy.maxMessages = Math.max(0, Math.floor(updates.defaultPolicy.maxMessages));
    }
  }

  if (updates.chatTypePolicies) {
    const validTypes: ChatType[] = ["dm", "group", "thread"];
    for (const ct of validTypes) {
      const patch = updates.chatTypePolicies[ct];
      if (!patch) continue;
      const existing = current.chatTypePolicies[ct] ?? { ...DEFAULT_RESET_POLICY };
      if (patch.idleTimeoutMinutes !== undefined) {
        existing.idleTimeoutMinutes = Math.max(0, Math.floor(patch.idleTimeoutMinutes));
      }
      if (patch.dailyResetHour !== undefined) {
        const h = patch.dailyResetHour;
        existing.dailyResetHour = h === null ? null : Math.max(0, Math.min(23, Math.floor(h)));
      }
      if (patch.maxMessages !== undefined) {
        existing.maxMessages = Math.max(0, Math.floor(patch.maxMessages));
      }
      current.chatTypePolicies[ct] = existing;
    }
  }

  if (updates.resetTriggers !== undefined) {
    current.resetTriggers = updates.resetTriggers.filter((t) => typeof t === "string" && t.trim().length > 0);
  }

  setConfig("session.lifecycle", JSON.stringify(current));
  return current;
}

/** Resolve the effective reset policy for a given chat type */
export function resolveResetPolicy(chatType?: "dm" | "group" | "thread"): SessionResetPolicy {
  const config = getSessionLifecycleConfig();
  if (chatType && config.chatTypePolicies[chatType]) {
    return config.chatTypePolicies[chatType]!;
  }
  return config.defaultPolicy;
}
