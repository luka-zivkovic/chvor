import { Hono } from "hono";
import {
  listSurfaces,
  getSurface,
  deleteSurface,
  deleteAllSurfaces,
  updateSurfaceTitle,
} from "../db/a2ui-store.ts";

const a2ui = new Hono();

// GET /api/a2ui/surfaces — lightweight list for sidebar
a2ui.get("/surfaces", (c) => {
  try {
    return c.json({ data: listSurfaces() });
  } catch (err) {
    console.error("[api] GET /a2ui/surfaces error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/a2ui/surfaces/:id — full surface with components + bindings
a2ui.get("/surfaces/:id", (c) => {
  const id = c.req.param("id");
  const surface = getSurface(id);
  if (!surface) return c.json({ error: "not found" }, 404);
  return c.json({ data: surface });
});

// PATCH /api/a2ui/surfaces/:id — update title/metadata
a2ui.patch("/surfaces/:id", async (c) => {
  const id = c.req.param("id");
  const surface = getSurface(id);
  if (!surface) return c.json({ error: "not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.title === "string") {
    updateSurfaceTitle(id, body.title);
  }
  return c.json({ data: { id, updated: true } });
});

// DELETE /api/a2ui/surfaces/:id — delete one surface
a2ui.delete("/surfaces/:id", (c) => {
  const id = c.req.param("id");
  deleteSurface(id);
  return c.json({ data: { id, deleted: true } });
});

// DELETE /api/a2ui/surfaces — delete all surfaces
a2ui.delete("/surfaces", (c) => {
  deleteAllSurfaces();
  return c.json({ data: { deleted: true } });
});

export default a2ui;
