import { Hono } from "hono";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import {
  createBackup,
  listBackups,
  deleteBackup,
  getBackupPath,
  getBackupConfig,
  updateBackupConfig,
  performRestore,
} from "../lib/backup.ts";
import { restartBackupScheduler } from "../lib/backup-scheduler.ts";

const backup = new Hono();

const MAX_RESTORE_SIZE = 500 * 1024 * 1024; // 500 MB
let restoreInProgress = false;

// Create a new backup (manual)
backup.post("/", async (c) => {
  try {
    const info = await createBackup("manual");
    return c.json({ data: info });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Backup failed" },
      500
    );
  }
});

// List existing backups
backup.get("/", (c) => {
  const backups = listBackups();
  return c.json({ data: backups });
});

// Download a backup by ID (filename)
backup.get("/download/:id", (c) => {
  const id = c.req.param("id");
  const filePath = getBackupPath(id);
  if (!filePath) {
    return c.json({ error: "Backup not found" }, 404);
  }

  const stat = statSync(filePath);
  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;
  const safeName = id.replace(/[^a-zA-Z0-9._-]/g, "_");

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(stat.size),
    },
  });
});

// Restore from uploaded backup
backup.post("/restore", async (c) => {
  if (restoreInProgress) {
    return c.json({ error: "A restore is already in progress" }, 409);
  }
  restoreInProgress = true;
  try {
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!file || !(file instanceof File)) {
      return c.json({ error: "Missing backup file" }, 400);
    }
    if (file.size > MAX_RESTORE_SIZE) {
      return c.json({ error: `Backup file too large (max ${MAX_RESTORE_SIZE / 1024 / 1024}MB)` }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    await performRestore(buffer);

    // Trigger graceful shutdown (uses existing SIGTERM handlers in index.ts)
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);

    return c.json({
      data: { success: true, message: "Restore complete. Server restarting..." },
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Restore failed" },
      500
    );
  } finally {
    restoreInProgress = false;
  }
});

// Delete a backup
backup.delete("/:id", (c) => {
  const id = c.req.param("id");
  const deleted = deleteBackup(id);
  if (!deleted) {
    return c.json({ error: "Backup not found" }, 404);
  }
  return c.json({ data: null });
});

// Get backup config
backup.get("/config", (c) => {
  return c.json({ data: getBackupConfig() });
});

// Update backup config
backup.patch("/config", async (c) => {
  const body = await c.req.json();
  try {
    const config = updateBackupConfig(body);
    // Restart scheduler with new settings
    restartBackupScheduler();
    return c.json({ data: config });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Invalid config" },
      400
    );
  }
});

export default backup;
