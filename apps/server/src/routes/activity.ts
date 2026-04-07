import { Hono } from "hono";
import { listActivities, countUnread, markRead, markAllRead } from "../db/activity-store.ts";

const activityRoute = new Hono();

activityRoute.get("/", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50") || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0") || 0, 0);
  return c.json({ data: listActivities(limit, offset) });
});

activityRoute.get("/unread", (c) => {
  return c.json({ data: { count: countUnread() } });
});

activityRoute.patch("/:id/read", (c) => {
  const found = markRead(c.req.param("id"));
  if (!found) return c.json({ error: "Activity not found" }, 404);
  return c.json({ data: { ok: true } });
});

activityRoute.patch("/read-all", (c) => {
  markAllRead();
  return c.json({ data: { ok: true } });
});

export default activityRoute;
