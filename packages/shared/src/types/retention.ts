export interface RetentionConfig {
  sessionMaxAgeDays: number; // 0 = never delete
  archiveBeforeDelete: boolean;
}

export interface UpdateRetentionRequest {
  sessionMaxAgeDays?: number;
  archiveBeforeDelete?: boolean;
}
