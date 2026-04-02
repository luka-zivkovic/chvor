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

const VALID_TASK_STATUSES = new Set<string>(["queued", "running", "completed", "failed", "cancelled"]);
const MAX_TASK_LIMIT = 1000;

daemon.get("/tasks", (c) => {
  try {
    const statusRaw = c.req.query("status");
    if (statusRaw && !VALID_TASK_STATUSES.has(statusRaw)) {
      return c.json({ error: `invalid status: must be one of ${[...VALID_TASK_STATUSES].join(", ")}` }, 400);
    }
    const status = statusRaw as DaemonTaskStatus | undefined;
    const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50), MAX_TASK_LIMIT);
    const tasks = listDaemonTasks({ status, limit });
    return c.json({ data: tasks });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

const MAX_TITLE_LENGTH = 200;
const MAX_PROMPT_LENGTH = 10_000;

daemon.post("/tasks", async (c) => {
  try {
    const body = (await c.req.json()) as CreateDaemonTaskRequest;
    if (!body.title?.trim() || !body.prompt?.trim()) {
      return c.json({ error: "title and prompt are required" }, 400);
    }
    const title = body.title.trim().slice(0, MAX_TITLE_LENGTH);
    const prompt = body.prompt.trim().slice(0, MAX_PROMPT_LENGTH);
    const priority = Math.max(0, Math.min(3, Math.floor(Number(body.priority ?? 1)) || 1));

    const task = createDaemonTask({
      title,
      prompt,
      priority,
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
