import { Hono } from "hono";
import { resolveIntegration } from "../lib/integration-resolver.ts";
import { researchIntegration } from "../lib/integration-research.ts";
import type { IntegrationResolution } from "@chvor/shared";

const integrations = new Hono();

// GET /research?q=<service_name>
integrations.get("/research", async (c) => {
  try {
    const query = c.req.query("q")?.trim();
    if (!query || query.length < 2) {
      return c.json({ error: "Query parameter 'q' is required (min 2 chars)" }, 400);
    }

    // Tier 1+2: check provider registry and chvor registry
    const resolution = await resolveIntegration(query);
    if (resolution) {
      return c.json(resolution);
    }

    // Tier 3: AI research
    const proposal = await researchIntegration(query);
    const result: IntegrationResolution = {
      source: "ai-research",
      name: proposal.name,
      credentialType: proposal.credentialType,
      fields: proposal.fields,
      proposal,
    };
    return c.json(result);
  } catch (err) {
    console.error("[integrations] research failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Research failed" },
      500
    );
  }
});

export default integrations;
