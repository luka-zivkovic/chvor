import { Hono } from "hono";
import { getCognitiveLoopRun, listCognitiveLoopEvents, listCognitiveLoopRuns } from "../db/cognitive-loop-store.ts";

const cognitiveLoop = new Hono();

cognitiveLoop.get("/", (c) => {
  const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20), 100);
  return c.json({ data: listCognitiveLoopRuns(limit) });
});

cognitiveLoop.get("/:id", (c) => {
  const id = c.req.param("id");
  const run = getCognitiveLoopRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json({ data: { run, events: listCognitiveLoopEvents(id) } });
});

export default cognitiveLoop;
