export type ChatType = "dm" | "group" | "thread";

export interface SessionResetPolicy {
  idleTimeoutMinutes: number; // 0 = disabled
  dailyResetHour: number | null; // null = disabled, 0-23
  maxMessages: number; // 0 = unlimited
}

export interface SessionLifecycleConfig {
  defaultPolicy: SessionResetPolicy;
  chatTypePolicies: Partial<Record<ChatType, SessionResetPolicy>>;
  resetTriggers: string[]; // e.g. ["/new", "/reset"]
}

export interface UpdateSessionLifecycleRequest {
  defaultPolicy?: Partial<SessionResetPolicy>;
  chatTypePolicies?: Partial<Record<ChatType, Partial<SessionResetPolicy>>>;
  resetTriggers?: string[];
}
