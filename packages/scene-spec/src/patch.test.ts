import { describe, expect, it } from "vitest";
import { applyPatch, type ScenePatch, ScenePatchSchema } from "./patch.ts";
import { hashSceneSpec } from "./revisions.ts";
import { validateSceneSpec } from "./schema.ts";
import {
  TOWER_BASE_ID,
  TOWER_MATERIAL_ID,
  TOWER_MID_ID,
  TOWER_ROOT_ID,
  towerSpec,
} from "./tower.ts";

function patchFor(baseHash: string, ops: ScenePatch["ops"]): ScenePatch {
  const parsed = ScenePatchSchema.safeParse({ baseRevision: baseHash, ops });
  if (!parsed.success) throw new Error(`test patch invalid: ${parsed.error.message}`);
  return parsed.data;
}

const CYLINDER_ID = "column";

/**
 * The tower fixture is boxes-only; segment-count validation needs a cylinder.
 * Appends one valid cylinder leaf to a cloned tower so integer-param tests
 * exercise the real patch path rather than a synthetic scene.
 */
function withCylinder(base: ReturnType<typeof towerSpec>): ReturnType<typeof towerSpec> {
  const spec = structuredClone(base);
  spec.nodes.push({
    kind: "procedural",
    id: CYLINDER_ID,
    name: "Column",
    transform: { position: [3, 1, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    op: "cylinder",
    params: {
      radiusTop: 0.2,
      radiusBottom: 0.3,
      height: 2,
      radialSegments: 12,
      heightSegments: 1,
      capped: true,
    },
    seed: 7,
    materialId: TOWER_MATERIAL_ID,
  });
  const root = spec.nodes.find((node) => node.id === TOWER_ROOT_ID);
  if (root?.kind !== "group") throw new Error("test fixture lost its root group");
  root.children.push(CYLINDER_ID);
  const validated = validateSceneSpec(spec);
  if (!validated.ok) throw new Error(`test fixture invalid: ${validated.error.message}`);
  return validated.value;
}

describe("applyPatch", () => {
  it("edits a box width", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 },
      ]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.nodes.find((node) => node.id === TOWER_BASE_ID);
    expect(base?.kind).toBe("procedural");
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.width).toBe(2.4);
    }
  });

  it("edits a box bevel", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "bevel", value: 0.1 },
      ]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.nodes.find((node) => node.id === TOWER_BASE_ID);
    expect(base?.kind).toBe("procedural");
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.bevel).toBe(0.1);
    }
  });

  it("rejects a bevel past half the smallest dimension at the operation level", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "bevel", value: 5 },
      ]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Operation-level, not a generic invalid_result.
      expect(result.error.code).toBe("invalid_value");
      expect(result.error.opIndex).toBe(0);
      expect(result.error.path).toBe("bevel");
      expect(result.error.reason).toBe("constraint");
    }
  });

  it("rejects a stale base revision", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor("0".repeat(64), [{ op: "rename", nodeId: TOWER_BASE_ID, name: "X" }]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stale_base");
  });

  it("rejects more than 64 operations at parse time", () => {
    const ops = Array.from({ length: 65 }, () => ({
      op: "rename" as const,
      nodeId: TOWER_BASE_ID,
      name: "X",
    }));
    expect(ScenePatchSchema.safeParse({ baseRevision: "0".repeat(64), ops }).success).toBe(false);
  });

  it("rejects an empty operation list", () => {
    expect(ScenePatchSchema.safeParse({ baseRevision: "0".repeat(64), ops: [] }).success).toBe(
      false,
    );
  });

  it("rejects unknown nodes without touching the scene", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "rename", nodeId: "ghost", name: "X" }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_node");
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("is atomic: a failing later op discards the earlier ones", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 },
        { op: "rename", nodeId: "ghost", name: "X" },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    // The input is untouched and no partial spec escapes: there is no result to inspect.
    expect(hashSceneSpec(spec)).toBe(before);
    const base = spec.nodes.find((node) => node.id === TOWER_BASE_ID);
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.width).toBe(2);
    }
  });

  it("rejects parameters the operation does not expose", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "radius", value: 1 }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_param");
  });

  it("rejects out-of-range values at the patch boundary", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: -2 }]),
      before,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects removing the root", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "remove_node", nodeId: TOWER_ROOT_ID }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cannot_remove_root");
  });

  it("removes a leaf and detaches it from its group", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "remove_node", nodeId: TOWER_MID_ID }]),
      before,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.some((node) => node.id === TOWER_MID_ID)).toBe(false);
    const root = result.value.nodes.find((node) => node.id === TOWER_ROOT_ID);
    expect(root?.kind).toBe("group");
    if (root?.kind === "group") expect(root.children).not.toContain(TOWER_MID_ID);
    expect(validateSceneSpec(result.value).ok).toBe(true);
  });

  it("adds a node to a group", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        {
          op: "add_node",
          parentId: TOWER_ROOT_ID,
          node: {
            kind: "procedural",
            id: "antenna",
            name: "Antenna",
            transform: { position: [0, 4.5, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
            op: "cylinder",
            params: {
              radiusTop: 0.05,
              radiusBottom: 0.05,
              height: 1,
              radialSegments: 12,
              heightSegments: 1,
              capped: true,
            },
            seed: 7,
            materialId: "concrete",
          },
        },
      ]),
      before,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.some((node) => node.id === "antenna")).toBe(true);
  });

  it("rejects adding a duplicate node id", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const mid = spec.nodes.find((node) => node.id === TOWER_MID_ID);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "add_node", parentId: TOWER_ROOT_ID, node: mid }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_node_id");
  });

  it("rejects a fractional value for the integer-only radialSegments", () => {
    const spec = withCylinder(towerSpec());
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "set_param", nodeId: CYLINDER_ID, key: "radialSegments", value: 12.7 },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_value");
      expect(result.error.opIndex).toBe(0);
      expect(result.error.path).toBe("radialSegments");
      expect(result.error.reason).toBe("not_integer");
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("rejects integer segment counts outside their bounds", () => {
    const spec = withCylinder(towerSpec());
    const before = hashSceneSpec(spec);
    for (const [value, reason] of [
      [2, "too_small"],
      [129, "too_big"],
    ] as const) {
      const result = applyPatch(
        spec,
        patchFor(before, [{ op: "set_param", nodeId: CYLINDER_ID, key: "radialSegments", value }]),
        before,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_value");
        expect(result.error.opIndex).toBe(0);
        expect(result.error.path).toBe("radialSegments");
        expect(result.error.reason).toBe(reason);
      }
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("rejects dimensions below the minimum and above the maximum", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    for (const [value, reason] of [
      [0.0005, "too_small"],
      [101, "too_big"],
    ] as const) {
      const result = applyPatch(
        spec,
        patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value }]),
        before,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_value");
        expect(result.error.opIndex).toBe(0);
        expect(result.error.path).toBe("width");
        expect(result.error.reason).toBe(reason);
      }
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("rejects shrinking a dimension below twice the existing bevel in one op", () => {
    const spec = towerSpec();
    const beveled = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "bevel", value: 0.4 },
      ]),
      hashSceneSpec(spec),
    );
    if (!beveled.ok) throw new Error("fixture patch failed");
    const before = hashSceneSpec(beveled.value);
    // A single width edit that would leave bevel 0.4 above half of 0.2 fails
    // at the failing op — never as a late generic invalid_result.
    const result = applyPatch(
      beveled.value,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 0.2 }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_value");
      expect(result.error.opIndex).toBe(0);
      expect(result.error.path).toBe("width");
    }
    expect(hashSceneSpec(beveled.value)).toBe(before);
  });

  it("rejects an unknown material identifier with the available materials named", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_material", nodeId: TOWER_BASE_ID, materialId: "brass" }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown_material");
      expect(result.error.opIndex).toBe(0);
      expect(result.error.message).toContain(TOWER_MATERIAL_ID);
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("adds a material so a following node edit can reference it", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        {
          op: "add_material",
          material: {
            id: "forest-green",
            name: "Forest green fabric",
            color: "#2f6f4e",
            metalness: 0,
            roughness: 0.96,
          },
        },
      ]),
      before,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.materials.at(-1)?.color).toBe("#2f6f4e");
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("rejects adding a duplicate material id", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        {
          op: "add_material",
          material: {
            id: TOWER_MATERIAL_ID,
            name: "Duplicate",
            color: "#2f6f4e",
            metalness: 0,
            roughness: 1,
          },
        },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_material");
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("rejects a malformed parameter path with the editable keys named", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "radius", value: 1 }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown_param");
      expect(result.error.opIndex).toBe(0);
      expect(result.error.path).toBe("radius");
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("names the failing operation index when a later operation fails", () => {
    const spec = withCylinder(towerSpec());
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 },
        { op: "rename", nodeId: TOWER_MID_ID, name: "Middle band" },
        { op: "set_param", nodeId: CYLINDER_ID, key: "heightSegments", value: 0 },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_value");
      expect(result.error.opIndex).toBe(2);
      expect(result.error.path).toBe("heightSegments");
      expect(result.error.reason).toBe("too_small");
    }
    // Atomic: the two valid earlier operations leave no trace on the input.
    expect(hashSceneSpec(spec)).toBe(before);
    const base = spec.nodes.find((node) => node.id === TOWER_BASE_ID);
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.width).toBe(2);
    }
  });

  it("reports the operation index when removing the root in a later op", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "rename", nodeId: TOWER_MID_ID, name: "Middle band" },
        { op: "remove_node", nodeId: TOWER_ROOT_ID },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cannot_remove_root");
      expect(result.error.opIndex).toBe(1);
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("leaves a failed patch input deeply equal to its snapshot", () => {
    const spec = withCylinder(towerSpec());
    const snapshot = structuredClone(spec);
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 },
        { op: "set_param", nodeId: CYLINDER_ID, key: "radialSegments", value: 12.7 },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    expect(spec).toEqual(snapshot);
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("accepts valid boundary values", () => {
    const spec = withCylinder(towerSpec());
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 100 },
        { op: "set_param", nodeId: CYLINDER_ID, key: "radialSegments", value: 3 },
        { op: "set_param", nodeId: CYLINDER_ID, key: "heightSegments", value: 64 },
      ]),
      before,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hashSceneSpec(result.value)).not.toBe(before);
    const upper = applyPatch(
      result.value,
      patchFor(hashSceneSpec(result.value), [
        { op: "set_param", nodeId: CYLINDER_ID, key: "radialSegments", value: 128 },
        { op: "set_param", nodeId: CYLINDER_ID, key: "heightSegments", value: 1 },
      ]),
      hashSceneSpec(result.value),
    );
    expect(upper.ok).toBe(true);
  });

  it("rejects a negative bevel at the operation level", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "bevel", value: -0.5 }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_value");
      expect(result.error.opIndex).toBe(0);
      expect(result.error.path).toBe("bevel");
      expect(result.error.reason).toBe("too_small");
    }
    expect(hashSceneSpec(spec)).toBe(before);
  });
});
