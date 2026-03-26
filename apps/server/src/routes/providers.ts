import { Hono } from "hono";
import {
  LLM_PROVIDERS,
  EMBEDDING_PROVIDERS,
  INTEGRATION_PROVIDERS,
} from "../lib/provider-registry.ts";

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

export default providers;
