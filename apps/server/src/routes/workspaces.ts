import { Hono } from "hono";
import {
  listWorkspaces,
  getWorkspace,
  saveWorkspace,
} from "../db/workspace-store.ts";

const workspaces = new Hono();

workspaces.get("/", (c) => {
  return c.json({ data: listWorkspaces() });
});

workspaces.get("/:id", (c) => {
  const workspace = getWorkspace(c.req.param("id"));
  if (!workspace) {
    return c.json({ error: "Workspace not found" }, 404);
  }
  return c.json({ data: workspace });
});

workspaces.put("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { data } = (body as Record<string, unknown>) ?? {};
  if (!data || typeof data !== "object") {
    return c.json({ error: "Missing or invalid data field" }, 400);
  }
  const payload = data as Parameters<typeof saveWorkspace>[1];
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    return c.json({ error: "data.nodes and data.edges must be arrays" }, 400);
  }
  const workspace = saveWorkspace(c.req.param("id"), payload);
  return c.json({ data: workspace });
});

export default workspaces;
