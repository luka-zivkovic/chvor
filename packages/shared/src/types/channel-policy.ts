export type ChannelPolicyDmMode = "open" | "allowlist" | "disabled";
export type ChannelPolicyGroupMode = "open" | "allowlist" | "disabled";

export interface ChannelPolicy {
  dm: {
    mode: ChannelPolicyDmMode;
    allowlist: string[];
  };
  group: {
    mode: ChannelPolicyGroupMode;
    allowlist: string[];
  };
  groupSenderFilter: {
    enabled: boolean;
    allowlist: string[];
  };
}

export interface UpdateChannelPolicyRequest {
  dm?: {
    mode?: ChannelPolicyDmMode;
    allowlist?: string[];
  };
  group?: {
    mode?: ChannelPolicyGroupMode;
    allowlist?: string[];
  };
  groupSenderFilter?: {
    enabled?: boolean;
    allowlist?: string[];
  };
}
