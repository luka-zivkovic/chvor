/**
 * Atomic writer for synthesized tool markdown files in ~/.chvor/tools/.
 *
 * Safety:
 *  - Refuses to overwrite user-authored tools (checks existing source via capability-loader).
 *  - Validates frontmatter shape before commit.
 *  - tmp-file + rename keeps races idempotent.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import type { SynthesizedEndpoint, SynthesizedToolConfig } from "@chvor/shared";
import { getTool } from "./capability-loader.ts";

const USER_TOOLS_DIR = process.env.CHVOR_TOOLS_DIR || join(homedir(), ".chvor", "tools");

const SLUG_RE = /^[a-z][a-z0-9-]{0,48}$/;
const ENDPOINT_NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;
const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface SynthToolSpec {
  slug: string;
  name: string;
  description: string;
  credentialType: string;
  synthesized: SynthesizedToolConfig;
  endpoints: SynthesizedEndpoint[];
  notes?: string;
}

export function validateSpec(spec: SynthToolSpec): void {
  if (!SLUG_RE.test(spec.slug)) {
    throw new Error(`invalid slug: ${spec.slug}`);
  }
  if (!spec.name || spec.name.length > 100) {
    throw new Error(`invalid name: ${spec.name}`);
  }
  if (!spec.credentialType || !SLUG_RE.test(spec.credentialType)) {
    throw new Error(`invalid credentialType: ${spec.credentialType}`);
  }
  if (spec.synthesized.credentialType !== spec.credentialType) {
    throw new Error(`credentialType mismatch between top-level and synthesized config`);
  }
  if (!spec.endpoints || spec.endpoints.length === 0) {
    throw new Error(`at least one endpoint required`);
  }
  if (spec.endpoints.length > 50) {
    throw new Error(`too many endpoints (max 50)`);
  }
  const seen = new Set<string>();
  for (const ep of spec.endpoints) {
    if (!ENDPOINT_NAME_RE.test(ep.name)) {
      throw new Error(`invalid endpoint name: ${ep.name}`);
    }
    if (seen.has(ep.name)) {
      throw new Error(`duplicate endpoint name: ${ep.name}`);
    }
    seen.add(ep.name);
    if (!VALID_METHODS.has(ep.method)) {
      throw new Error(`invalid method on ${ep.name}: ${ep.method}`);
    }
    if (!ep.path || !ep.path.startsWith("/")) {
      throw new Error(`endpoint path must start with /: ${ep.name}`);
    }
  }
  if (spec.synthesized.timeoutMs !== undefined) {
    const t = spec.synthesized.timeoutMs;
    if (!Number.isFinite(t) || t < 1_000 || t > 600_000) {
      throw new Error(`synthesized.timeoutMs must be between 1000 and 600000 ms`);
    }
  }
  if (spec.synthesized.credentialId !== undefined && typeof spec.synthesized.credentialId !== "string") {
    throw new Error(`synthesized.credentialId must be a string when set`);
  }
}

/**
 * Indent any line whose first non-whitespace characters are `---` so user-supplied
 * notes can't close the frontmatter fence and inject YAML that gets loaded on the
 * next capability reload. Single regex catches trailing-whitespace, trailing-text,
 * and leading-whitespace variants in one pass.
 */
function sanitizeNotes(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => (/^\s*---/.test(line) ? `  ${line}` : line))
    .join("\n");
}

function buildMarkdown(spec: SynthToolSpec): string {
  const frontmatter = {
    name: spec.name,
    description: spec.description,
    version: "1.0.0",
    type: "tool" as const,
    author: "chvor-synthesized",
    requires: {
      credentials: [spec.credentialType],
    },
    mcp: {
      transport: "synthesized" as const,
    },
    synthesized: spec.synthesized,
    endpoints: spec.endpoints,
  };

  const yaml = yamlStringify(frontmatter, { lineWidth: 0 });
  const rawNotes = spec.notes?.trim() ||
    `Synthesized ${spec.synthesized.source} tool for ${spec.name}.` +
    (spec.synthesized.specUrl ? ` Spec: ${spec.synthesized.specUrl}` : "");
  const notes = sanitizeNotes(rawNotes);

  return `---\n${yaml}---\n${notes}\n`;
}

export interface WriteResult {
  path: string;
  created: boolean;
  overwrote: boolean;
}

/** Atomically write a synthesized tool to ~/.chvor/tools/<slug>.md. */
export function writeSynthesizedTool(spec: SynthToolSpec): WriteResult {
  validateSpec(spec);

  const existing = getTool(spec.slug);
  if (existing && existing.source === "user" && !existing.mcpServer) {
    throw new Error(`a user-authored tool "${spec.slug}" already exists — refusing to overwrite`);
  }
  if (existing && existing.source === "bundled") {
    throw new Error(`a bundled tool "${spec.slug}" already exists — pick a different slug`);
  }

  const path = join(USER_TOOLS_DIR, `${spec.slug}.md`);
  const overwrote = existsSync(path);
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, buildMarkdown(spec), "utf8");
  renameSync(tmpPath, path);

  return { path, created: !overwrote, overwrote };
}
