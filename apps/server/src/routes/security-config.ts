import { Hono } from "hono";
import { getAllowLocalhost, setAllowLocalhost } from "../db/config-store.ts";

const securityConfig = new Hono();

securityConfig.get("/", (c) => {
  return c.json({ data: { allowLocalhost: getAllowLocalhost() } });
});

securityConfig.patch("/", async (c) => {
  try {
    const body = (await c.req.json()) as { allowLocalhost?: boolean };
    if (body.allowLocalhost !== undefined) {
      setAllowLocalhost(body.allowLocalhost);
    }
    return c.json({ data: { allowLocalhost: getAllowLocalhost() } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default securityConfig;
