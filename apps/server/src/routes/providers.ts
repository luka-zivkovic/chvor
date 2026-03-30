import { Hono } from "hono";
import {
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  INTEGRATION_PROVIDERS,
} from "../lib/provider-registry.ts";
import { fetchModelsForProvider, clearModelCache } from "../lib/model-fetcher.ts";

const providers = new Hono();

providers.get("/", (c) => {
  return c.json({
    data: {
      llm: LLM_PROVIDERS,
      embedding: EMBEDDING_PROVIDERS,
      integration: INTEGRATION_PROVIDERS,
    },
  });
});

// ── Auto-discovery: probe default local ports for running services ──
// IMPORTANT: must be registered before /:id/models to avoid route shadowing

const LOCAL_PROBES: { id: string; url: string }[] = [
  { id: "ollama", url: "http://localhost:11434/api/tags" },
  { id: "lmstudio", url: "http://localhost:1234/v1/models" },
  { id: "vllm", url: "http://localhost:8000/v1/models" },
];

providers.get("/discovery", async (c) => {
  const results = await Promise.allSettled(
    LOCAL_PROBES.map(async ({ id, url }) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return { id, available: res.ok };
    }),
  );

  const discovered = results
    .filter(
      (r): r is PromiseFulfilledResult<{ id: string; available: boolean }> =>
        r.status === "fulfilled" && r.value.available,
    )
    .map((r) => r.value.id);

  return c.json({ data: { discovered } });
});

// ── Dynamic model list per provider ─────────────────────────────

providers.get("/:id/models", async (c) => {
  const providerId = c.req.param("id");
  const providerDef = LLM_PROVIDERS.find((p) => p.id === providerId);
  if (!providerDef) {
    return c.json({ error: `Unknown provider: ${providerId}` }, 404);
  }

  const result = await fetchModelsForProvider(providerId);
  return c.json({ data: result });
});

// ── Cache invalidation (called when credentials change) ─────────

providers.delete("/:id/models/cache", (c) => {
  const providerId = c.req.param("id");
  clearModelCache(providerId);
  return c.json({ ok: true });
});

export default providers;
