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
  const body = await c.req.json();
  const { data } = body as { data: Parameters<typeof saveWorkspace>[1] };
  if (!data) {
    return c.json({ error: "Missing data field" }, 400);
  }
  const workspace = saveWorkspace(c.req.param("id"), data);
  return c.json({ data: workspace });
});

export default workspaces;
