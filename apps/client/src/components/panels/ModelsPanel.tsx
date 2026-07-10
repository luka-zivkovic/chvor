import { useEffect, useState } from "react";
import { useConfigStore } from "../../stores/config-store";
import { useFeatureStore } from "../../stores/feature-store";
import { cn } from "@/lib/utils";
import { EmbeddingsSection } from "./model-config/EmbeddingsSection";
import { RoleSelector } from "./model-config/RoleSelector";

/* ─── Main Panel ─── */

export function ModelsPanel() {
  const { fetchModelsConfig, modelsLoading: loading } = useConfigStore();
  const { fetchCredentials: fetchAll } = useFeatureStore();
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    fetchModelsConfig();
    fetchAll();
  }, [fetchModelsConfig, fetchAll]);

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Chat Models */}
      <div>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Chat Models
        </h3>
        <div className="flex flex-col gap-3">
          <RoleSelector
            role="primary"
            label="Primary"
            description="Main model for chat and reasoning"
          />
          <RoleSelector
            role="reasoning"
            label="Reasoning"
            description="Complex tasks — can use reasoning models like DeepSeek-R1 or o3"
          />
        </div>
      </div>

      {/* Advanced */}
      <div>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={cn("transition-transform", showAdvanced && "rotate-90")}>
            <polyline points="9 6 15 12 9 18" />
          </svg>
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-2 flex flex-col gap-3">
            <RoleSelector
              role="lightweight"
              label="Lightweight"
              description="Memory extraction, summarization, pipeline steps"
            />
            <RoleSelector
              role="heartbeat"
              label="Heartbeat"
              description="Pulse/awareness checks — runs periodically"
            />
          </div>
        )}
      </div>

      {/* Embeddings */}
      <div>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Embeddings
        </h3>
        <EmbeddingsSection />
      </div>
    </div>
  );
}
