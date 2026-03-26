export interface BackupManifest {
  version: 1;
  chvorVersion: string;
  createdAt: string;
  source: "manual" | "scheduled";
  platform: string;
  dbSizeBytes: number;
  skillCount: number;
  toolCount: number;
  id: string;
}

export interface BackupInfo {
  id: string;
  filename: string;
  createdAt: string;
  source: "manual" | "scheduled";
  sizeBytes: number;
}

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  maxCount: number;
  maxAgeDays: number;
  directory: string;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface UpdateBackupConfigRequest {
  enabled?: boolean;
  intervalHours?: number;
  maxCount?: number;
  maxAgeDays?: number;
  directory?: string;
}
