import { getDb } from "../database.ts";
import { getConfig, setConfig } from "./base.ts";

// ── Instruction overrides ───────────────────────────────────────

/** Get a user-defined instruction override for a skill or tool. Returns null if no override exists. */
export function getInstructionOverride(kind: "skill" | "tool", id: string): string | null {
  return getConfig(`${kind}.instructions.override.${id}`);
}

/** Save a user-defined instruction override for a skill or tool. */
export function setInstructionOverride(kind: "skill" | "tool", id: string, instructions: string): void {
  setConfig(`${kind}.instructions.override.${id}`, instructions);
}

/** Clear a user-defined instruction override, restoring original instructions. */
export function clearInstructionOverride(kind: "skill" | "tool", id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM config WHERE key = ?").run(`${kind}.instructions.override.${id}`);
}

/** Get all instruction overrides (for template export). */
export function getAllInstructionOverrides(): Array<{ kind: "skill" | "tool"; id: string; instructions: string }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT key, value FROM config WHERE key LIKE 'skill.instructions.override.%' OR key LIKE 'tool.instructions.override.%'"
  ).all() as { key: string; value: string }[];
  return rows.map((r) => {
    // key format: "{kind}.instructions.override.{id}"
    // Use fixed prefix lengths for robust parsing (skill.instructions.override. = 28, tool.instructions.override. = 27)
    const isSkill = r.key.startsWith("skill.");
    const kind = isSkill ? "skill" as const : "tool" as const;
    const prefixLen = isSkill ? "skill.instructions.override.".length : "tool.instructions.override.".length;
    const id = r.key.slice(prefixLen);
    return { kind, id, instructions: r.value };
  });
}
