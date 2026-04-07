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
  try {
    const id = c.req.param("id");
    const surface = getSurface(id);
    if (!surface) return c.json({ error: "not found" }, 404);
    return c.json({ data: surface });
  } catch (err) {
    console.error("[api] GET /a2ui/surfaces/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// PATCH /api/a2ui/surfaces/:id — update title/metadata
a2ui.patch("/surfaces/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const surface = getSurface(id);
    if (!surface) return c.json({ error: "not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title || title.length > 200) {
        return c.json({ error: "title must be 1-200 characters" }, 400);
      }
      updateSurfaceTitle(id, title);
    }
    return c.json({ data: { id, updated: true } });
  } catch (err) {
    console.error("[api] PATCH /a2ui/surfaces/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/a2ui/surfaces/:id — delete one surface
a2ui.delete("/surfaces/:id", (c) => {
  try {
    const id = c.req.param("id");
    const deleted = deleteSurface(id);
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ data: { id, deleted: true } });
  } catch (err) {
    console.error("[api] DELETE /a2ui/surfaces/:id error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /api/a2ui/surfaces — delete all surfaces
a2ui.delete("/surfaces", (c) => {
  try {
    deleteAllSurfaces();
    return c.json({ data: { deleted: true } });
  } catch (err) {
    console.error("[api] DELETE /a2ui/surfaces error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

export default a2ui;
