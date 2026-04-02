import { Hono } from "hono";
import type { CreateMemoryRequest, UpdateMemoryRequest } from "@chvor/shared";
import {
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  deleteAllMemories,
  getEdgesForMemory,
  getNeighborMemories,
  getMemoryGraph,
  getMemoryStats,
} from "../db/memory-store.ts";

const memories = new Hono();

memories.get("/", (c) => {
  try {
    return c.json({ data: listMemories() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

memories.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as CreateMemoryRequest;
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    const memory = createMemory({
      abstract: body.content.trim(),
      category: body.category ?? "profile",
      sourceChannel: "manual",
      sourceSessionId: "manual",
      provenance: "stated",
      confidence: 1.0,
    });
    return c.json({ data: memory }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

memories.get("/graph", (c) => {
  try {
    return c.json({ data: getMemoryGraph() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

memories.get("/stats", (c) => {
  try {
    return c.json({ data: getMemoryStats() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Register specific sub-routes before parameterized /:id to prevent route shadowing
memories.get("/:id/neighbors", (c) => {
  try {
    const id = c.req.param("id");
    const memory = getMemory(id);
    if (!memory) return c.json({ error: "not found" }, 404);
    const neighbors = getNeighborMemories(id);
    const edges = getEdgesForMemory(id);
    return c.json({ data: { memory, neighbors, edges } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

memories.get("/:id", (c) => {
  try {
    const memory = getMemory(c.req.param("id"));
    if (!memory) return c.json({ error: "not found" }, 404);
    return c.json({ data: memory });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

memories.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json()) as UpdateMemoryRequest;
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    const updated = updateMemory(id, body.content.trim());
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Register DELETE / before DELETE /:id to prevent route shadowing
memories.delete("/", (c) => {
  try {
    deleteAllMemories();
    return c.json({ data: null });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

memories.delete("/:id", (c) => {
  try {
    const id = c.req.param("id");
    const deleted = deleteMemory(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ data: null });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default memories;
