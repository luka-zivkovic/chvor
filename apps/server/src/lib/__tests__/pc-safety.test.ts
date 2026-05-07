import { describe, expect, it } from "vitest";
import { tryActionRouter } from "../action-patterns.ts";
import { assessPcTaskSafety, classifyPcAction } from "../pc-safety.ts";

function assess(task: string) {
  return assessPcTaskSafety(task, tryActionRouter(task));
}

describe("pc safety assessment", () => {
  it("auto-approves low-impact routed navigation in semi-autonomous mode", () => {
    expect(assess("scroll down")).toMatchObject({
      tier: "safe",
      autoApprovableInSemiAutonomous: true,
    });
  });

  it("requires approval for typed text even when action-routed", () => {
    expect(assess('type "hello world"')).toMatchObject({
      tier: "moderate",
      autoApprovableInSemiAutonomous: false,
    });
  });

  it("treats app-closing shortcuts as dangerous", () => {
    expect(assess("close window")).toMatchObject({
      tier: "dangerous",
      autoApprovableInSemiAutonomous: false,
    });
  });

  it("blocks broad destructive PC intents", () => {
    for (const task of [
      "delete all user files",
      "remove all user files",
      "delete every file",
      "destroy my documents folder",
      "erase my downloads",
      "wipe my downloads",
      "delete my documents",
      "remove all photos",
      "erase all user files",
      "format the filesystem",
      "run rm -rf / in terminal",
    ]) {
      const result = assessPcTaskSafety(task, null);
      expect(result.tier).toBe("blocked");
      expect(result.autoApprovableInSemiAutonomous).toBe(false);
    }
  });

  it("does not block scoped text-editing deletion phrasing", () => {
    expect(assessPcTaskSafety("delete all text in this field", null).tier).toBe("dangerous");
  });

  it("requires approval for unknown LLM-planned tasks", () => {
    const result = assessPcTaskSafety("open Firefox", null);
    expect(result).toMatchObject({
      tier: "moderate",
      autoApprovableInSemiAutonomous: false,
    });
  });

  it("does not auto-approve safe non-routed planned actions in semi-autonomous mode", () => {
    expect(
      assessPcTaskSafety("scroll the active pane", [{ action: "scroll", direction: "down" }], {
        routedActions: false,
      })
    ).toMatchObject({
      tier: "safe",
      autoApprovableInSemiAutonomous: false,
    });
  });

  it("requires approval for state-changing routed shortcuts", () => {
    for (const task of ["save", "close tab", "copy", "paste", "select all"]) {
      const result = assess(task);
      expect(result.autoApprovableInSemiAutonomous).toBe(false);
      expect(["moderate", "dangerous"]).toContain(result.tier);
    }
  });

  it("classifies clicks as moderate planned actions", () => {
    expect(classifyPcAction({ action: "left_click", coordinate: [10, 10] })).toMatchObject({
      tier: "moderate",
    });
  });

  it("blocks planned typing of destructive shell commands", () => {
    expect(classifyPcAction({ action: "type", text: "rm -rf /" })).toMatchObject({
      tier: "blocked",
    });
  });

  it("classifies common trash/uninstall/overwrite intents as dangerous", () => {
    for (const task of [
      "empty trash",
      "move to trash",
      "uninstall the app",
      "overwrite the file",
    ]) {
      expect(assessPcTaskSafety(task, null).tier).toBe("dangerous");
    }
  });
});
