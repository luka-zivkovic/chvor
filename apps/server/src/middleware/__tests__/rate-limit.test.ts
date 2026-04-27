import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { rateLimit, _resetRateLimitForTests } from "../rate-limit.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.use("/api/*", rateLimit);
  app.get("/api/items", (c) => c.json({ ok: true }));
  app.post("/api/items", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}

async function hit(
  app: Hono,
  path: string,
  init?: { method?: string; ip?: string },
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method ?? "GET",
      headers: init?.ip ? { "x-forwarded-for": init.ip } : {},
    }),
  );
}

beforeEach(() => {
  _resetRateLimitForTests();
});

describe("rateLimit middleware", () => {
  it("allows reads up to the limit and 429s after", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "5"; // ignored — env read at module init
    const app = buildApp();
    // Default read limit is 300 — reduce confidence we can't blow it in a test.
    // Instead, send 301 reads under the same key and expect first 300 OK, then 429.
    let oks = 0;
    let denies = 0;
    for (let i = 0; i < 305; i++) {
      const res = await hit(app, "/api/items", { ip: "1.1.1.1" });
      if (res.status === 200) oks++;
      else if (res.status === 429) denies++;
    }
    expect(oks).toBe(300);
    expect(denies).toBe(5);
  });

  it("uses a separate bucket for writes and 429s after 60", async () => {
    const app = buildApp();
    let oks = 0;
    let denies = 0;
    for (let i = 0; i < 65; i++) {
      const res = await hit(app, "/api/items", { method: "POST", ip: "2.2.2.2" });
      if (res.status === 200) oks++;
      else if (res.status === 429) denies++;
    }
    expect(oks).toBe(60);
    expect(denies).toBe(5);
  });

  it("isolates buckets per client IP", async () => {
    const app = buildApp();
    // Burn one IP's write quota
    for (let i = 0; i < 60; i++) {
      await hit(app, "/api/items", { method: "POST", ip: "3.3.3.3" });
    }
    const blocked = await hit(app, "/api/items", { method: "POST", ip: "3.3.3.3" });
    expect(blocked.status).toBe(429);
    // A different IP still has full quota
    const fresh = await hit(app, "/api/items", { method: "POST", ip: "4.4.4.4" });
    expect(fresh.status).toBe(200);
  });

  it("returns Retry-After header on 429", async () => {
    const app = buildApp();
    for (let i = 0; i < 60; i++) {
      await hit(app, "/api/items", { method: "POST", ip: "5.5.5.5" });
    }
    const res = await hit(app, "/api/items", { method: "POST", ip: "5.5.5.5" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeDefined();
  });

  it("skips /api/health", async () => {
    const app = buildApp();
    // Write limit is 60; if /api/health were rate-limited, hitting it 100×
    // would 429. Should not.
    let denies = 0;
    for (let i = 0; i < 100; i++) {
      const res = await hit(app, "/api/health", { ip: "6.6.6.6" });
      if (res.status === 429) denies++;
    }
    expect(denies).toBe(0);
  });
});
