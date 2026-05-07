import { describe, expect, it } from "vitest";
import type { A11yTree, PcScreenshot } from "@chvor/shared";
import { __pcPipelineInternals } from "../pc-pipeline.ts";

const tree: A11yTree = {
  platform: "test",
  timestamp: "2026-05-07T00:00:00.000Z",
  nodeCount: 4,
  root: { id: 1, role: "window", name: "Root" },
};

const screenshot: PcScreenshot = {
  data: "base64-image",
  width: 1024,
  height: 576,
  timestamp: "2026-05-07T00:00:00.000Z",
  mimeType: "image/jpeg",
};

describe("pc pipeline parser internals", () => {
  it("allows a11y-planned scroll without a coordinate", async () => {
    const actions = await __pcPipelineInternals.parseActionsFromLlm(
      '[{"action":"scroll","direction":"down"}]',
      tree,
      { width: 1920, height: 1080 },
      { width: 1024, height: 576 }
    );

    expect(actions).toHaveLength(1);
    expect(actions?.[0]).toMatchObject({ action: "scroll", direction: "down" });
    expect(actions?.[0].coordinate).toBeUndefined();
    expect(actions?.[0].screenWidth).toBeUndefined();
    expect(actions?.[0].screenHeight).toBeUndefined();
  });

  it("still rejects a11y-planned clicks without a coordinate or node", async () => {
    const actions = await __pcPipelineInternals.parseActionsFromLlm(
      '[{"action":"left_click"}]',
      tree,
      { width: 1920, height: 1080 },
      { width: 1024, height: 576 }
    );

    expect(actions).toBeNull();
  });

  it("requires a coordinate for vision-planned scroll", () => {
    expect(
      __pcPipelineInternals.parseVisionActions(
        '[{"action":"scroll","direction":"down"}]',
        screenshot
      )
    ).toEqual([]);
  });

  it("accepts vision-planned scroll with a coordinate", () => {
    expect(
      __pcPipelineInternals.parseVisionActions(
        '[{"action":"scroll","direction":"down","coordinate":[10,20]}]',
        screenshot
      )
    ).toEqual([
      {
        action: "scroll",
        coordinate: [10, 20],
        screenWidth: 1024,
        screenHeight: 576,
        text: undefined,
        keys: undefined,
        direction: "down",
        amount: undefined,
        duration: undefined,
      },
    ]);
  });
});
