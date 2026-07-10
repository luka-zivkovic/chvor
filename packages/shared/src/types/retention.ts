export interface RetentionConfig {
  sessionMaxAgeDays: number; // 0 = never delete
  trajectoryMaxAgeDays: number; // 0 = never delete
  archiveBeforeDelete: boolean;
}

export interface UpdateRetentionRequest {
  sessionMaxAgeDays?: number;
  trajectoryMaxAgeDays?: number;
  archiveBeforeDelete?: boolean;
}
