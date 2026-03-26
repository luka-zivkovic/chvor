import { join } from "node:path";
import { existsSync } from "node:fs";
import { confirm } from "@inquirer/prompts";
import { getDataDir } from "../lib/paths.js";

export async function authReset(): Promise<void> {
  const dataDir = getDataDir();
  const dbPath = join(dataDir, "chvor.db");

  if (!existsSync(dbPath)) {
    console.error("No database found at", dbPath);
    console.error("Nothing to reset.");
    process.exit(1);
  }

  const confirmed = await confirm({
    message:
      "This will remove all authentication data (login credentials, sessions, API keys).\nYou will need to set up new credentials on next login.\n\nContinue?",
    default: false,
  });

  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  // Dynamic import — better-sqlite3 is an optional peer dep for the CLI
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Database: any;
  try {
    const mod = await import("better-sqlite3");
    Database = mod.default;
  } catch {
    console.error(
      "better-sqlite3 is not installed. Install it to use auth reset:\n  npm install better-sqlite3"
    );
    process.exit(1);
  }

  const db = new Database(dbPath);
  try {
    // Check if auth tables exist
    const hasAuthConfig = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_config'"
      )
      .get();

    if (!hasAuthConfig) {
      console.log("Auth tables not found — nothing to reset.");
      return;
    }

    db.exec("DELETE FROM auth_config");
    db.exec("DELETE FROM auth_sessions");
    db.exec("DELETE FROM api_keys");

    console.log(
      "\nAuthentication reset successfully.\nYou will be prompted to set up new credentials on next login."
    );
  } finally {
    db.close();
  }
}
