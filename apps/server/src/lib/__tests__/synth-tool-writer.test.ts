import { describe, it, expect, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// writeSynthesizedTool touches the filesystem; we only test the in-memory
// markdown it would have produced, so we mock capability-loader to avoid
// real I/O and stub process.env to pin USER_TOOLS_DIR to tmp.
vi.mock("../capability-loader.ts", () => ({
  getTool: vi.fn(() => null),
}));

import type { SynthToolSpec } from "../synth-tool-writer.ts";

// Directly exercise `buildMarkdown` via the public `writeSynthesizedTool` path
// would write to disk — instead we re-import the module and reach into the
// exported validation helper. Since `buildMarkdown` is module-private, we
// test via the side-effect-free path: construct the same string the writer
// would generate.
//
// To keep the test hermetic and focused on sanitizeNotes behavior, we invoke
// writeSynthesizedTool with a mocked fs and read the bytes it intended to
// write.
vi.mock("node:fs", async () => {
  let written = "";
  return {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((_path: string, content: string) => {
      written = content;
    }),
    renameSync: vi.fn(),
    // Test-only accessor — not part of real fs.
    __getWritten: () => written,
    __reset: () => { written = ""; },
  };
});

import { writeSynthesizedTool } from "../synth-tool-writer.ts";
import * as fs from "node:fs";

function runWrite(notes: string): string {
  (fs as unknown as { __reset: () => void }).__reset();
  const spec: SynthToolSpec = {
    slug: "acme-api",
    name: "Acme API",
    description: "test tool",
    credentialType: "acme-token",
    synthesized: {
      source: "openapi",
      verified: false,
      credentialType: "acme-token",
      generatedAt: new Date().toISOString(),
    },
    endpoints: [
      { name: "ping", description: "ping endpoint", method: "GET", path: "/ping" },
    ],
    notes,
  };
  writeSynthesizedTool(spec);
  return (fs as unknown as { __getWritten: () => string }).__getWritten();
}

/**
 * Split the markdown at its frontmatter fences and parse only the YAML block.
 * If a notes-bypass succeeded, `evil` or similar keys would appear in this
 * parsed object.
 */
function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("no frontmatter found");
  return parseYaml(match[1]) as Record<string, unknown>;
}

describe("synth-tool-writer sanitizeNotes", () => {
  it("escapes plain '---' so notes can't reopen the frontmatter", () => {
    const md = runWrite("---\nevil: yes\n");
    const front = parseFrontmatter(md);
    expect(front.evil).toBeUndefined();
    expect(front.name).toBe("Acme API");
  });

  it("escapes leading-whitespace '---' — the classic bypass", () => {
    const md = runWrite("   ---\nevil: 1\n");
    const front = parseFrontmatter(md);
    expect(front.evil).toBeUndefined();
  });

  it("escapes '---' followed by non-whitespace content", () => {
    const md = runWrite("---foo\nhidden: true");
    const front = parseFrontmatter(md);
    expect(front.hidden).toBeUndefined();
    expect(front.foo).toBeUndefined();
  });

  it("escapes CRLF-terminated '---' lines", () => {
    const md = runWrite("---\r\nescaped: true\r\n");
    const front = parseFrontmatter(md);
    expect(front.escaped).toBeUndefined();
  });

  it("leaves legitimate notes untouched", () => {
    const md = runWrite("Some notes about the API.\nNo fences here.");
    expect(md).toContain("Some notes about the API.");
    expect(md).toContain("No fences here.");
  });
});
