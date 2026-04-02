import { Hono } from "hono";
import type { CreateDaemonTaskRequest, UpdateDaemonConfigRequest } from "@chvor/shared";
import { getDaemonConfig, updateDaemonConfig } from "../db/config-store.ts";
import { getDaemonPresence, syncDaemon } from "../lib/daemon-engine.ts";
import { listDaemonTasks, getDaemonTask, createDaemonTask, cancelDaemonTask } from "../db/daemon-store.ts";
import type { DaemonTaskStatus } from "@chvor/shared";

const daemon = new Hono();

daemon.get("/config", (c) => {
  return c.json({ data: getDaemonConfig() });
});

daemon.patch("/config", async (c) => {
  try {
    const body = (await c.req.json()) as UpdateDaemonConfigRequest;
    const updated = updateDaemonConfig(body);
    syncDaemon();
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

daemon.get("/presence", (c) => {
  return c.json({ data: getDaemonPresence() });
});

daemon.get("/tasks", (c) => {
  try {
    const status = c.req.query("status") as DaemonTaskStatus | undefined;
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const tasks = listDaemonTasks({ status, limit });
    return c.json({ data: tasks });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

daemon.post("/tasks", async (c) => {
  try {
    const body = (await c.req.json()) as CreateDaemonTaskRequest;
    if (!body.title?.trim() || !body.prompt?.trim()) {
      return c.json({ error: "title and prompt are required" }, 400);
    }
    const task = createDaemonTask({
      title: body.title.trim(),
      prompt: body.prompt.trim(),
      priority: body.priority,
      source: "user",
    });
    return c.json({ data: task }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

daemon.get("/tasks/:id", (c) => {
  const task = getDaemonTask(c.req.param("id"));
  if (!task) return c.json({ error: "not found" }, 404);
  return c.json({ data: task });
});

daemon.delete("/tasks/:id", (c) => {
  const cancelled = cancelDaemonTask(c.req.param("id"));
  if (!cancelled) return c.json({ error: "not found or not cancellable" }, 404);
  return c.json({ data: null });
});

export default daemon;
