import { useRef, useState } from "react";
import { useFeatureStore } from "../../../stores/feature-store";
import { api } from "../../../lib/api";
import type { LLMProviderDef, ModelDef } from "@chvor/shared";

/* ─── Dynamic model cache hook ─── */

const _dynamicModelCache = new Map<string, ModelDef[]>();

export function useDynamicModels() {
  const cacheRef = useRef(_dynamicModelCache);
  const [loading, setLoading] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  const credentials = useFeatureStore((s) => s.credentials);
  const credVersionRef = useRef(credentials);
  if (credVersionRef.current !== credentials) {
    credVersionRef.current = credentials;
    cacheRef.current.clear();
  }

  const getModels = (provider: LLMProviderDef | null | undefined): ModelDef[] => {
    if (!provider) return [];
    return cacheRef.current.get(provider.id) ?? provider.models;
  };

  const fetchModels = (provider: LLMProviderDef | null | undefined) => {
    if (!provider) return;
    if (cacheRef.current.has(provider.id)) return;

    setLoading(provider.id);
    api.providers.models(provider.id)
      .then((result) => {
        if (result.models.length > 0) {
          cacheRef.current.set(provider.id, result.models);
          forceUpdate((n) => n + 1);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(null));
  };

  return { getModels, fetchModels, loading };
}
