import { describe, expect, it } from "vitest";
import { buildScene } from "@vibe-vr/procedural/build";
import { validateSceneSpec } from "@vibe-vr/scene-spec/schema";
import { buildDemoChair, isDefaultChairRequest } from "./demo-chair.ts";
import { classifySceneRequest } from "./dahl-provider.ts";

describe("short-prompt demo chair", () => {
  it("builds a valid detailed chair with grounded legs and supported geometry", () => {
    const spec = buildDemoChair();
    expect(validateSceneSpec(spec).ok).toBe(true);
    expect(buildScene(spec).ok).toBe(true);
    expect(spec.materials).toHaveLength(3);
    expect(spec.nodes.length).toBeGreaterThanOrEqual(17);
    const legs = spec.nodes.filter((node) => node.kind === "procedural" && node.op === "cylinder");
    expect(legs).toHaveLength(4);
    for (const leg of legs) {
      if (leg.kind === "procedural" && leg.op === "cylinder") {
        expect(leg.transform.position[1] - leg.params.height / 2).toBeCloseTo(0);
      }
    }
  });

  it("preserves explicit design choices and follow-up edits for the model", () => {
    expect(isDefaultChairRequest("сделай мне стул")).toBe(true);
    expect(classifySceneRequest("сделай мне стул").type).toBe("object_creation");
    expect(isDefaultChairRequest("Create a chair.")).toBe(true);
    expect(isDefaultChairRequest("сделай мне красный стул")).toBe(false);
    expect(isDefaultChairRequest("сделай стул выше")).toBe(false);
  });
});
