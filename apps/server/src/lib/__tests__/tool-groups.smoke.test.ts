import { describe, it, expect } from "vitest";
import type { Skill } from "@chvor/shared";
import { resolveSkillBag, filterTools, summarizeScope } from "../tool-groups.ts";
import { getNativeToolDefinitions, getNativeToolGroupMap } from "../native-tools.ts";

function makeSkill(id: string, partial: Partial<Skill["metadata"]> = {}): Skill {
  return {
    kind: "skill",
    id,
    skillType: "prompt",
    instructions: "",
    source: "bundled",
    path: `${id}.md`,
    metadata: {
      name: id,
      description: id,
      version: "1.0.0",
      ...partial,
    },
  };
}

describe("tool-groups — resolveSkillBag", () => {
  it("returns permissive scope when no skills are active", () => {
    const scope = resolveSkillBag([]);
    expect(scope.isPermissive).toBe(true);
    expect(scope.groups.has("*")).toBe(true);
    expect(scope.contributingSkills).toHaveLength(0);
  });

  it("returns permissive scope when no active skill declares scoping", () => {
    const skills = [makeSkill("brainstorming"), makeSkill("writing-helper")];
    const scope = resolveSkillBag(skills);
    expect(scope.isPermissive).toBe(true);
    expect(scope.permissiveReason).toBe(
      "no active skill declared requiredGroups / requiredTools / deniedTools"
    );
  });

  it("strict scope when at least one skill declares requiredGroups", () => {
    const skills = [
      makeSkill("twitter-poster", { requiredGroups: ["social", "web"] }),
      makeSkill("brainstorming"),
    ];
    const scope = resolveSkillBag(skills);
    expect(scope.isPermissive).toBe(false);
    expect(scope.groups.has("social")).toBe(true);
    expect(scope.groups.has("web")).toBe(true);
    // core is always implicitly included
    expect(scope.groups.has("core")).toBe(true);
    // legacy skill that declared nothing should NOT downgrade us back to permissive
    expect(scope.groups.has("*")).toBe(false);
    expect(scope.contributingSkills).toContain("twitter-poster");
    expect(scope.contributingSkills).not.toContain("brainstorming");
  });

  it("unions groups across multiple declaring skills + accumulates required/denied", () => {
    const skills = [
      makeSkill("a", { requiredGroups: ["pc", "browser"], requiredTools: ["native__pc_do"] }),
      makeSkill("b", { requiredGroups: ["browser", "knowledge"], deniedTools: ["native__shell_execute"] }),
    ];
    const scope = resolveSkillBag(skills);
    expect(Array.from(scope.groups).sort()).toEqual(["browser", "core", "knowledge", "pc"]);
    expect(Array.from(scope.requiredTools)).toEqual(["native__pc_do"]);
    expect(Array.from(scope.deniedTools)).toEqual(["native__shell_execute"]);
  });
});

describe("tool-groups — filterTools (MCP / synth)", () => {
  function makeTool(id: string, group?: string): import("@chvor/shared").Tool {
    return {
      kind: "tool",
      id,
      instructions: "",
      source: "bundled",
      path: `${id}.md`,
      builtIn: true,
      mcpServer: { transport: "stdio", command: "echo" },
      metadata: {
        name: id,
        description: id,
        version: "1.0.0",
        group: group as import("@chvor/shared").ToolGroupId | undefined,
      },
    };
  }

  it("permissive scope returns the input untouched", () => {
    const tools = [makeTool("a", "social"), makeTool("b", "browser")];
    const scope = resolveSkillBag([]);
    expect(filterTools(tools, scope)).toEqual(tools);
  });

  it("strict scope keeps tools whose group is active and drops the rest", () => {
    const tools = [makeTool("twitter", "social"), makeTool("github", "git"), makeTool("misc")];
    const scope = resolveSkillBag([
      makeSkill("twitter-poster", { requiredGroups: ["social"] }),
    ]);
    const kept = filterTools(tools, scope);
    expect(kept.map((t) => t.id).sort()).toEqual(["twitter"]);
  });

  it("requiredTools surface a tool even when its group isn't in the bag", () => {
    const tools = [makeTool("github", "git")];
    const scope = resolveSkillBag([
      makeSkill("a", { requiredGroups: ["web"], requiredTools: ["github__create_issue"] }),
    ]);
    const kept = filterTools(tools, scope);
    expect(kept.map((t) => t.id)).toEqual(["github"]);
  });
});

describe("tool-groups — getNativeToolDefinitions(scope)", () => {
  it("with permissive scope, returns ALL native tools (parity with no-arg call)", () => {
    const all = Object.keys(getNativeToolDefinitions());
    const permissive = Object.keys(getNativeToolDefinitions(resolveSkillBag([])));
    expect(permissive.sort()).toEqual(all.sort());
  });

  it("strict scope of group=core only keeps core + always-available tools", () => {
    const scope = resolveSkillBag([makeSkill("a", { requiredGroups: ["core"] })]);
    const groupMap = getNativeToolGroupMap();
    const kept = Object.keys(getNativeToolDefinitions(scope));
    for (const name of kept) {
      const tag = groupMap[name];
      expect(["core"].includes(tag.group) || tag.criticality === "always-available").toBe(true);
    }
  });

  it("group=web admits web tools + drops shell tools, but always-available still passes", () => {
    const scope = resolveSkillBag([makeSkill("a", { requiredGroups: ["web"] })]);
    const groupMap = getNativeToolGroupMap();
    const kept = new Set(Object.keys(getNativeToolDefinitions(scope)));

    // recall_detail is always-available (core + criticality)
    expect(kept.has("native__recall_detail")).toBe(true);
    // web tools admitted by group
    expect(kept.has("native__fetch") || kept.has("native__web_search")).toBe(true);
    // shell isn't in scope and isn't always-available — should NOT be in bag
    expect(kept.has("native__shell_execute")).toBe(false);
    // sandbox is not in scope and isn't always-available — should NOT be in bag
    expect(kept.has("native__sandbox_execute")).toBe(false);

    // sanity: every kept tool is either web/core or always-available
    for (const name of kept) {
      const tag = groupMap[name];
      const ok =
        tag.criticality === "always-available" ||
        tag.group === "web" ||
        tag.group === "core";
      expect(ok).toBe(true);
    }
  });

  it("deniedTools removes a tool even when its group is active", () => {
    const scope = resolveSkillBag([
      makeSkill("a", { requiredGroups: ["shell"], deniedTools: ["native__shell_execute"] }),
    ]);
    const kept = new Set(Object.keys(getNativeToolDefinitions(scope)));
    // always-available still passes regardless of denied list — that's the contract
    // shell_execute is NOT always-available, so should be excluded
    expect(kept.has("native__shell_execute")).toBe(false);
  });

  it("every native tool has a group + criticality", () => {
    const map = getNativeToolGroupMap();
    expect(Object.keys(map).length).toBeGreaterThan(20);
    for (const [name, tag] of Object.entries(map)) {
      expect(tag.group, `tool ${name} missing group`).toBeTruthy();
      expect(["always-available", "normal"]).toContain(tag.criticality);
    }
  });
});

describe("tool-groups — summarizeScope", () => {
  it("produces a stable JSON shape for canvas events", () => {
    const scope = resolveSkillBag([
      makeSkill("twitter-poster", { requiredGroups: ["social", "web"] }),
    ]);
    const summary = summarizeScope(scope);
    expect(summary.groups.sort()).toEqual(["core", "social", "web"]);
    expect(summary.isPermissive).toBe(false);
    expect(summary.contributingSkills).toEqual(["twitter-poster"]);
  });
});
