import { Hono } from "hono";
import {
  listSessions,
  getSessionById,
  deleteSession,
  deleteAllSessions,
  getSessionMessages,
  getSessionTimelineMessages,
  branchSessionFromMessage,
  listChannelTargets,
  updateSessionTitle,
  updateSessionArchive,
  getSessionTitle,
} from "../db/session-store.ts";
import { getCheckpoint, listCheckpointSummaries } from "../db/checkpoint-store.ts";

const sessions = new Hono();

sessions.get("/", (c) => {
  try {
    const archived = c.req.query("archived");
    const search = c.req.query("search");
    const data = listSessions({
      archived: archived === "true" ? true : archived === "false" ? false : undefined,
      search: search || undefined,
    });
    return c.json({ data });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.get("/targets", (c) => {
  try {
    return c.json({ data: listChannelTargets() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.get("/:id/messages", (c) => {
  try {
    const id = c.req.param("id");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;
    const messages = getSessionMessages(id, limit, offset);
    return c.json({ data: messages });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.get("/:id/timeline", (c) => {
  try {
    const id = c.req.param("id");
    const messages = getSessionTimelineMessages(id);
    const checkpoints = listCheckpointSummaries({ sessionId: id, limit: 200 })
      .map((summary) => getCheckpoint(summary.id))
      .filter((checkpoint) => checkpoint !== null);
    return c.json({ data: { messages, checkpoints } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.post("/:id/branch", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: string; title?: string };
    const branch = branchSessionFromMessage(id, {
      messageId: typeof body.messageId === "string" ? body.messageId : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    if (!branch) return c.json({ error: "session or branch point not found" }, 404);
    return c.json({ data: branch }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.get("/:id", (c) => {
  try {
    const session = getSessionById(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({ data: session });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<{ title?: string; archived?: boolean }>();

    if (typeof body.title === "string") {
      const updated = updateSessionTitle(id, body.title);
      if (!updated) return c.json({ error: "not found" }, 404);
    }

    if (typeof body.archived === "boolean") {
      const updated = updateSessionArchive(id, body.archived);
      if (!updated) return c.json({ error: "not found" }, 404);
    }

    return c.json({ data: { ok: true } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.post("/:id/generate-title", async (c) => {
  try {
    const id = c.req.param("id");
    // Idempotency guard: skip if title already set
    const existing = getSessionTitle(id);
    if (existing !== null) {
      return c.json({ data: { title: existing, generated: false } });
    }

    // Lazy import to avoid circular deps
    const { generateSessionTitle } = await import("../lib/title-generator.ts");
    const title = await generateSessionTitle(id);
    if (title) {
      updateSessionTitle(id, title);
      return c.json({ data: { title, generated: true } });
    }
    return c.json({ data: { title: null, generated: false } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Register DELETE / before /:id to avoid route shadowing
sessions.delete("/", (c) => {
  try {
    deleteAllSessions();
    return c.json({ data: null });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

sessions.delete("/:id", (c) => {
  try {
    const deleted = deleteSession(c.req.param("id"));
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.json({ data: null });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

export default sessions;
