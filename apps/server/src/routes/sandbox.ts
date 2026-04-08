import { Hono } from "hono";
import type { UpdateSandboxConfigRequest, SandboxLanguage } from "@chvor/shared";
import { getSandboxConfig, updateSandboxConfig } from "../db/config-store.ts";
import { checkDockerAvailable, listAvailableImages, pullImage } from "../lib/sandbox.ts";
import { invalidateToolCache } from "../lib/tool-builder.ts";

const sandboxRoute = new Hono();

sandboxRoute.get("/", (c) => {
  return c.json({ data: getSandboxConfig() });
});

sandboxRoute.patch("/", async (c) => {
  try {
    const raw = await c.req.json();
    const ALLOWED_KEYS = ["enabled", "memoryLimitMb", "cpuQuota", "timeoutMs", "networkDisabled"];
    const body: UpdateSandboxConfigRequest = Object.fromEntries(
      Object.entries(raw).filter(([k]) => ALLOWED_KEYS.includes(k))
    );
    const updated = updateSandboxConfig(body);
    invalidateToolCache();
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sandboxRoute.get("/status", async (c) => {
  try {
    const docker = await checkDockerAvailable();
    const allLangs: SandboxLanguage[] = ["python", "node", "bash"];
    const images = docker.available ? await listAvailableImages() : [];
    return c.json({
      data: {
        dockerAvailable: docker.available,
        dockerVersion: docker.version,
        imagesAvailable: images,
        imagesMissing: allLangs.filter((l) => !images.includes(l)),
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sandboxRoute.post("/pull", async (c) => {
  try {
    const { language } = (await c.req.json()) as { language?: string };
    const VALID_LANGUAGES: SandboxLanguage[] = ["python", "node", "bash"];
    if (language && !VALID_LANGUAGES.includes(language as SandboxLanguage)) {
      return c.json({ error: `Invalid language: "${language}". Supported: python, node, bash.` }, 400);
    }
    const langs: SandboxLanguage[] = language ? [language as SandboxLanguage] : VALID_LANGUAGES;
    const results: Record<string, string> = {};
    for (const lang of langs) {
      try {
        await pullImage(lang);
        results[lang] = "pulled";
      } catch (err) {
        results[lang] = `failed: ${String(err)}`;
      }
    }
    return c.json({ data: results });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default sandboxRoute;
