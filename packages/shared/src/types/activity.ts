export type ActivitySource = "pulse" | "schedule" | "self-healing" | "workflow" | "credential-access" | "webhook" | "pc-control" | "daemon" | "synthesized-write";

export interface ActivityEntry {
  id: string;
  timestamp: string;
  source: ActivitySource;
  title: string;
  content: string | null;
  read: boolean;
  scheduleId: string | null;
}

export interface SelfHealingStatus {
  enabled: boolean;
  errors24h: number;
  lastRepairAt: string | null;
}
