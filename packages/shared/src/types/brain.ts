export interface BrainConfig {
  maxToolRounds: number; // 1-100, default 30
  memoryBatchSize: number; // extract memories every N turns, default 3
  lowTokenMode: boolean; // reduces LLM usage: doubles batch size, skips consolidation passes, disables proactive ingestion
}

export interface UpdateBrainConfigRequest {
  maxToolRounds?: number;
  memoryBatchSize?: number;
  lowTokenMode?: boolean;
}
