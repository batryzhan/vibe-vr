import type { SceneMaterial, SceneSpec } from "@vibe-vr/scene-spec/schema";
import { towerSpec } from "@vibe-vr/scene-spec/tower";
import { describe, expect, it } from "vitest";
import type { AssembledObject } from "./component.ts";
import { buildDeskPlan, replanDesk } from "./desk.ts";

const WALNUT: SceneMaterial = {
  id: "walnut",
  name: "Walnut",
  color: "#5a3a22",
  metalness: 0,
  roughness: 0.6,
};
const BLACK: SceneMaterial = {
  id: "matte_black",
  name: "Matte black",
  color: "#1b1b1e",
  metalness: 0,
  roughness: 0.9,
};
/** A canonical-shaped scene around one assembly, for replan tests. */
function specFromAssembly(
  assembly: AssembledObject,
  id: string,
  materials: SceneMaterial[] = [WALNUT, BLACK],
): SceneSpec {
  const nodes = assembly.components.map((part) => {
    const leaf = {
      kind: "procedural" as const,
      id: part.spec.id,
      name: part.spec.id,
      transform: part.spec.transform,
      seed: 0,
      materialId: part.spec.material.id,
    };
    if (part.spec.op === "box" && "width" in part.spec.params) {
      return { ...leaf, op: "box" as const, params: part.spec.params };
    }
    if (part.spec.op === "cylinder" && "radiusTop" in part.spec.params) {
      return { ...leaf, op: "cylinder" as const, params: part.spec.params };
    }
    throw new Error(`fixture part "${part.spec.id}" has mismatched op and params`);
  });
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000099",
    seed: 0,
    units: "m",
    axes: "y-up",
    nodes: [
      {
        kind: "group" as const,
        id,
        name: "Desk",
        transform: {
          position: [0, 0, 0] as [number, number, number],
          rotationEuler: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        children: nodes.map((node) => node.id),
      },
      ...nodes,
    ],
    materials,
    root: id,
  };
}

function walnutDesk() {
  return buildDeskPlan({
    topWidth: 1.6,
    topDepth: 0.8,
    topMaterial: { material: "walnut" },
    legMaterial: { material: "matte_black" },
  });
}

describe("buildDeskPlan", () => {
  it("builds eleven validated parts with pinned count and footprint", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.components).toHaveLength(11);
    expect(built.value.triangleCount).toBe(168);
    expect(built.value.bounds.min[1]).toBeCloseTo(0, 9);
    expect(built.value.bounds.max[1]).toBeCloseTo(0.78, 9);
  });

  it("fills documented defaults and derives placement from the top", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const leg = built.value.components.find((part) => part.spec.id === "desk-leg-front-left");
    expect(leg?.bounds.min[0]).toBeCloseTo(-0.77, 9);
  });

  it("rejects unknown fields, bad dimensions, and unsupported materials", () => {
    expect(buildDeskPlan({ topWidth: 1.6, topDepth: 0.8, wheels: 4 } as never).ok).toBe(false);
    const badWidth = buildDeskPlan({ topWidth: -1, topDepth: 0.8 });
    expect(badWidth.ok).toBe(false);
    if (!badWidth.ok) expect(badWidth.error.field).toBe("topWidth");
    const badMaterial = buildDeskPlan({
      topWidth: 1.6,
      topDepth: 0.8,
      topMaterial: { material: "glass" },
    });
    expect(badMaterial.ok).toBe(false);
  });

  it("rejects tops its legs cannot fit under", () => {
    const built = buildDeskPlan({ topWidth: 0.1, topDepth: 0.8 });
    expect(built.ok).toBe(false);
  });

  it("rebuilds deterministically", () => {
    const first = walnutDesk();
    const second = buildDeskPlan({
      topWidth: 1.6,
      topDepth: 0.8,
      topMaterial: { material: "walnut" },
      legMaterial: { material: "matte_black" },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.bounds).toEqual(second.value.bounds);
    expect(first.value.triangleCount).toBe(second.value.triangleCount);
  });
});

describe("replanDesk", () => {
  it("widens top, legs, and aprons in one atomic op list", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const replanned = replanDesk(specFromAssembly(built.value, "desk"), { topWidth: 2.0 });
    expect(replanned.ok).toBe(true);
    if (!replanned.ok) return;
    const ops = replanned.value.ops;
    // Top width, four leg positions (posts and feet), two apron widths: every
    // dependent moves, nothing else is touched. Apron z stays put — only the
    // width changed — so each apron sees exactly one op.
    const forNode = (id: string) => ops.filter((op) => "nodeId" in op && op.nodeId === id);
    expect(forNode("desk-top").map((op) => op.op)).toEqual(["set_param"]);
    expect(forNode("desk-apron-front").map((op) => op.op)).toEqual(["set_param"]);
    expect(forNode("desk-apron-back").map((op) => op.op)).toEqual(["set_param"]);
    for (const leg of ["front-left", "front-right", "back-left", "back-right"]) {
      expect(forNode(`desk-leg-${leg}`).map((op) => op.op)).toEqual(["set_transform"]);
      expect(forNode(`desk-leg-${leg}-foot`).map((op) => op.op)).toEqual(["set_transform"]);
    }
    expect(ops).toHaveLength(1 + 2 + 8);
  });

  it("swaps to a present material and refuses an absent one by name", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const spec = specFromAssembly(built.value, "desk");
    const swapped = replanDesk(spec, { legMaterial: { material: "walnut" } });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.value.ops.length).toBeGreaterThan(0);
    expect(
      swapped.value.ops.every((op) => op.op === "set_material" && op.materialId === "walnut"),
    ).toBe(true);
    const missing = replanDesk(spec, { topMaterial: { material: "oak" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toMatch(/oak/);
  });

  it("names every touched part in the returned summary", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const replanned = replanDesk(specFromAssembly(built.value, "desk"), {
      topWidth: 2.0,
      legMaterial: { material: "walnut" },
    });
    expect(replanned.ok).toBe(true);
    if (!replanned.ok) return;
    // Before-to-after lines for what changed, plus the operation count line.
    expect(replanned.value.summary).toContain("top width 1.6 m → 2 m");
    expect(replanned.value.summary).toContain("leg material matte_black → walnut");
    expect(replanned.value.summary.at(-1)).toMatch(/operation\(s\) across \d+ part\(s\)\./);
    // The count line agrees with the actual ops.
    const parts = new Set(
      replanned.value.ops.filter((op) => "nodeId" in op).map((op) => op.nodeId),
    );
    expect(replanned.value.summary.at(-1)).toBe(
      `${replanned.value.ops.length} operation(s) across ${parts.size} part(s).`,
    );
  });

  it("reports no changes and non-desk scenes plainly", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const spec = specFromAssembly(built.value, "desk");
    const empty = replanDesk(spec, {});
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("no_changes");
    const tower = replanDesk(towerSpec(), { topWidth: 2.0 });
    expect(tower.ok).toBe(false);
    if (!tower.ok) expect(tower.error.code).toBe("not_a_desk");
  });

  /**
   * Every refusal below asserts the code, the offending part, and that the
   * input scene is untouched — a refused replan must never half-derive.
   */
  function expectRefusal(
    spec: SceneSpec,
    changes: Parameters<typeof replanDesk>[1],
    componentId: string,
  ): void {
    const snapshot = structuredClone(spec);
    const replanned = replanDesk(spec, changes);
    expect(replanned.ok).toBe(false);
    if (!replanned.ok) {
      expect(replanned.error.code).toBe("not_representable");
      expect(replanned.error.componentId).toBe(componentId);
    }
    expect(spec).toEqual(snapshot);
  }

  function deskSpec(): SceneSpec {
    const built = walnutDesk();
    if (!built.ok) throw new Error("fixture desk failed to build");
    return specFromAssembly(built.value, "desk");
  }

  function boxPart(
    spec: SceneSpec,
    id: string,
  ): SceneSpec["nodes"][number] & {
    kind: "procedural";
  } {
    const node = spec.nodes.find((entry) => entry.id === id);
    if (node?.kind !== "procedural" || node.op !== "box") {
      throw new Error(`fixture lost its box part "${id}"`);
    }
    return node;
  }

  it("refuses an apron moved in Y", () => {
    const spec = deskSpec();
    const apron = boxPart(spec, "desk-apron-front");
    apron.transform.position = [
      apron.transform.position[0],
      apron.transform.position[1] + 0.05,
      apron.transform.position[2],
    ];
    expectRefusal(spec, { topWidth: 2.0 }, "desk-apron-front");
  });

  it("refuses a foot moved in X", () => {
    const spec = deskSpec();
    const foot = boxPart(spec, "desk-leg-front-left-foot");
    foot.transform.position = [
      foot.transform.position[0] + 0.05,
      foot.transform.position[1],
      foot.transform.position[2],
    ];
    expectRefusal(spec, { topWidth: 2.0 }, "desk-leg-front-left-foot");
  });

  it("refuses a customized leg height", () => {
    const spec = deskSpec();
    const leg = boxPart(spec, "desk-leg-front-left");
    if (!("height" in leg.params)) throw new Error("fixture leg lost its height");
    leg.params.height += 0.1;
    expectRefusal(spec, { topWidth: 2.0 }, "desk-leg-front-left");
  });

  it("refuses a leg with mirrored X sign", () => {
    const spec = deskSpec();
    const leg = boxPart(spec, "desk-leg-front-left");
    leg.transform.position = [
      -leg.transform.position[0],
      leg.transform.position[1],
      leg.transform.position[2],
    ];
    expectRefusal(spec, { topWidth: 2.0 }, "desk-leg-front-left");
  });

  it("refuses a scaled and rotated top", () => {
    const spec = deskSpec();
    const top = boxPart(spec, "desk-top");
    top.transform.rotationEuler = [0, 0.5, 0];
    top.transform.scale = [1.1, 1, 1];
    expectRefusal(spec, { topWidth: 2.0 }, "desk-top");
  });

  it("refuses a leg Z offset differing from the X inset", () => {
    const spec = deskSpec();
    const leg = boxPart(spec, "desk-leg-front-left");
    leg.transform.position = [
      leg.transform.position[0],
      leg.transform.position[1],
      leg.transform.position[2] + 0.1,
    ];
    expectRefusal(spec, { topWidth: 2.0 }, "desk-leg-front-left");
  });

  it("refuses a part replaced by a group node", () => {
    const spec = deskSpec();
    spec.nodes = spec.nodes.filter((node) => node.id !== "desk-top");
    spec.nodes.push({
      kind: "group",
      id: "desk-top",
      name: "Tabletop",
      transform: {
        position: [0, 0.75, 0],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
      children: [],
    });
    expectRefusal(spec, { topWidth: 2.0 }, "desk-top");
  });

  it("refuses a desk missing a foot instead of skipping it", () => {
    const spec = deskSpec();
    spec.nodes = spec.nodes.filter((node) => node.id !== "desk-leg-front-left-foot");
    const root = spec.nodes.find((node) => node.id === "desk");
    if (root?.kind !== "group") throw new Error("fixture lost its root group");
    root.children = root.children.filter((id) => id !== "desk-leg-front-left-foot");
    expectRefusal(spec, { topWidth: 2.0 }, "desk-leg-front-left-foot");
  });

  it("leaves the input scene untouched when replanning fails", () => {
    const built = walnutDesk();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const spec = specFromAssembly(built.value, "desk");
    const snapshot = structuredClone(spec);
    const replanned = replanDesk(towerSpec(), { topWidth: 2.0 });
    expect(replanned.ok).toBe(false);
    expect(spec).toEqual(snapshot);
    expect(replanDesk(spec, { topWidth: 2.0 }).ok).toBe(true);
  });
});
