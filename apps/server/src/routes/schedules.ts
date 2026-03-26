import { Hono } from "hono";
import type { CreateScheduleRequest, UpdateScheduleRequest } from "@chvor/shared";
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listScheduleRuns,
} from "../db/schedule-store.ts";
import { syncSchedule } from "../lib/scheduler.ts";
import { getWSInstance } from "../gateway/ws-instance.ts";

const schedules = new Hono();

schedules.get("/", (c) => {
  try {
    return c.json({ data: listSchedules() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

schedules.get("/:id", (c) => {
  try {
    const schedule = getSchedule(c.req.param("id"));
    if (!schedule) return c.json({ error: "not found" }, 404);
    return c.json({ data: schedule });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

schedules.get("/:id/runs", (c) => {
  try {
    const runs = listScheduleRuns(c.req.param("id"));
    return c.json({ data: runs });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

schedules.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as CreateScheduleRequest;
    if (
      !body.name ||
      !body.cronExpression ||
      !body.prompt ||
      !body.workspaceId
    ) {
      return c.json(
        { error: "name, cronExpression, prompt, and workspaceId are required" },
        400
      );
    }
    const schedule = createSchedule(body);
    syncSchedule(schedule.id);
    getWSInstance()?.broadcast({ type: "schedule.created", data: schedule });
    return c.json({ data: schedule }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

schedules.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateScheduleRequest;
    const updated = updateSchedule(id, body);
    if (!updated) return c.json({ error: "not found" }, 404);
    syncSchedule(id);
    getWSInstance()?.broadcast({ type: "schedule.updated", data: updated });
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

schedules.delete("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const deleted = deleteSchedule(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    syncSchedule(id);
    getWSInstance()?.broadcast({ type: "schedule.deleted", data: { id } });
    return c.json({ data: null });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default schedules;
