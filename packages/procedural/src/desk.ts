/**
 * Desk plans: a typed, validated front door for one object family.
 *
 * A desk plan names dimensions and semantic materials; this module derives
 * every dependent coordinate through the placement helpers, builds the parts
 * through the existing component path, and assembles them. `replanDesk`
 * answers follow-up edits the same way: it re-derives the full part list
 * from merged dimensions and diffs it against the live scene, so widening a
 * top moves its legs and aprons in one atomic op list instead of stranding
 * them.
 *
 * Two deliberate boundaries. First, materials: the plan chooses from small
 * explicit vocabularies, and an edit may only name a material the scene
 * already carries — the patch language cannot introduce materials, so neither
 * can this module, and the refusal names what is available. Second, identity:
 * part ids (`desk-top`, `desk-leg-*`, `desk-apron-*`) are fixed by the
 * builder, which is what lets a later replan find its parts; a scene without
 * them is not a planner desk and is refused as such rather than guessed at.
 */

import type { PatchOp } from "@vibe-vr/scene-spec/patch";
import type { SceneMaterial, SceneNode, SceneSpec } from "@vibe-vr/scene-spec/schema";
import type { Result } from "@vibe-vr/shared/result";
import type { Bounds } from "./build.ts";
import {
  type AssembledObject,
  assembleComponents,
  type BuiltComponent,
  buildComponent,
  type ComponentError,
  type ComponentSpec,
} from "./component.ts";
import { footedPost, panel } from "./detail.ts";
import {
  resolveSemanticMaterial,
  type SemanticFinish,
  type SemanticMaterialId,
} from "./material.ts";
import { apronPair, tableLegCenters, verticalSpan } from "./placement.ts";

/** Top bounds derived from plan dimensions: the placement input. */
function topBounds(
  topWidth: number,
  topDepth: number,
  height: number,
  topThickness: number,
): Bounds {
  return {
    min: [-topWidth / 2, height - topThickness, -topDepth / 2],
    max: [topWidth / 2, height, topDepth / 2],
  };
}

/** Woods a desktop may wear. Legs admit matte black as well. */
const TOP_MATERIALS: readonly SemanticMaterialId[] = ["walnut", "oak", "maple"];
const LEG_MATERIALS: readonly SemanticMaterialId[] = ["matte_black", "walnut", "oak", "maple"];

const MATERIAL_DISPLAY_NAMES: Record<string, string> = {
  walnut: "Walnut",
  oak: "Oak",
  maple: "Maple",
  matte_black: "Matte black",
};

export type DeskMaterialChoice = {
  material: SemanticMaterialId;
  finish?: SemanticFinish | undefined;
};

export type DeskPlan = {
  topWidth: number;
  topDepth: number;
  height?: number;
  topThickness?: number;
  legWidth?: number;
  legDepth?: number;
  inset?: number;
  apronHeight?: number;
  apronThickness?: number;
  bevel?: number;
  topMaterial?: DeskMaterialChoice;
  legMaterial?: DeskMaterialChoice;
};

export type DeskPlanError = {
  code:
    | ComponentError["code"]
    | "invalid_plan"
    | "not_a_desk"
    | "not_representable"
    | "unknown_material"
    | "no_changes";
  message: string;
  field?: string;
  componentId?: string;
};

type ResolvedDeskPlan = {
  topWidth: number;
  topDepth: number;
  height: number;
  topThickness: number;
  legWidth: number;
  legDepth: number;
  inset: number;
  apronHeight: number;
  apronThickness: number;
  bevel: number;
  top: SceneMaterial;
  legs: SceneMaterial;
};

function invalidPlan(field: string, message: string): DeskPlanError {
  return { code: "invalid_plan", message: `desk plan field "${field}": ${message}`, field };
}

function requirePositive(value: unknown, field: string): number | DeskPlanError {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return invalidPlan(field, "must be a positive finite number");
  }
  return value;
}

function resolveChoice(
  choice: unknown,
  field: string,
  allowed: readonly SemanticMaterialId[],
): SceneMaterial | DeskPlanError {
  if (typeof choice !== "object" || choice === null) {
    return invalidPlan(field, "must be an object with a material name");
  }
  const { material, finish } = choice as { material?: unknown; finish?: unknown };
  if (typeof material !== "string" || !allowed.includes(material as SemanticMaterialId)) {
    return invalidPlan(
      field,
      `unknown material "${String(material)}" (available: ${allowed.join(", ")})`,
    );
  }
  const id = material as SemanticMaterialId;
  try {
    const resolved = resolveSemanticMaterial(id, finish as SemanticFinish | undefined);
    return {
      id,
      name: MATERIAL_DISPLAY_NAMES[id] ?? id,
      color: resolved.colorHex,
      metalness: resolved.metalness,
      roughness: resolved.roughness,
    };
  } catch (error) {
    return invalidPlan(field, error instanceof Error ? error.message : String(error));
  }
}

const PLAN_FIELDS = [
  "topWidth",
  "topDepth",
  "height",
  "topThickness",
  "legWidth",
  "legDepth",
  "inset",
  "apronHeight",
  "apronThickness",
  "bevel",
  "topMaterial",
  "legMaterial",
] as const;

function resolveDeskPlan(input: unknown): Result<ResolvedDeskPlan, DeskPlanError> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: invalidPlan("(root)", "must be an object") };
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(PLAN_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: invalidPlan(key, "unknown desk plan field") };
    }
  }
  const take = (field: (typeof PLAN_FIELDS)[number], fallback: number): number | DeskPlanError => {
    const value = raw[field] ?? fallback;
    return requirePositive(value, field);
  };
  const topWidth = take("topWidth", Number.NaN);
  if (typeof topWidth !== "number") return { ok: false, error: topWidth };
  const topDepth = take("topDepth", Number.NaN);
  if (typeof topDepth !== "number") return { ok: false, error: topDepth };
  const height = take("height", 0.78);
  if (typeof height !== "number") return { ok: false, error: height };
  const topThickness = take("topThickness", 0.06);
  if (typeof topThickness !== "number") return { ok: false, error: topThickness };
  const legWidth = take("legWidth", 0.06);
  if (typeof legWidth !== "number") return { ok: false, error: legWidth };
  const legDepth = take("legDepth", 0.06);
  if (typeof legDepth !== "number") return { ok: false, error: legDepth };
  const inset = raw.inset ?? 0.03;
  if (typeof inset !== "number" || !Number.isFinite(inset) || inset < 0) {
    return { ok: false, error: invalidPlan("inset", "must be a finite number at least 0") };
  }
  const apronHeight = take("apronHeight", 0.09);
  if (typeof apronHeight !== "number") return { ok: false, error: apronHeight };
  const apronThickness = take("apronThickness", 0.04);
  if (typeof apronThickness !== "number") return { ok: false, error: apronThickness };
  const bevel = raw.bevel ?? 0.01;
  if (typeof bevel !== "number" || !Number.isFinite(bevel) || bevel < 0) {
    return { ok: false, error: invalidPlan("bevel", "must be a finite number at least 0") };
  }
  if (topThickness >= height) {
    return { ok: false, error: invalidPlan("height", "must clear the tabletop thickness") };
  }
  const top = resolveChoice(
    raw.topMaterial ?? { material: "walnut" },
    "topMaterial",
    TOP_MATERIALS,
  );
  if ("code" in top) return { ok: false, error: top };
  const legs = resolveChoice(
    raw.legMaterial ?? { material: "matte_black" },
    "legMaterial",
    LEG_MATERIALS,
  );
  if ("code" in legs) return { ok: false, error: legs };
  return {
    ok: true,
    value: {
      topWidth,
      topDepth,
      height,
      topThickness,
      legWidth,
      legDepth,
      inset,
      apronHeight,
      apronThickness,
      bevel,
      top,
      legs,
    },
  };
}

type DeskPartMaterials = { top: SceneMaterial; legs: SceneMaterial };

/**
 * Derive every part from resolved dimensions: the single code path the
 * builder and the replan diff share, so a dimension means the same part in
 * both. Aprons follow the top material — one woodwork, one choice.
 */
function deriveDeskParts(
  dims: Omit<ResolvedDeskPlan, "top" | "legs">,
  materials: DeskPartMaterials,
): ComponentSpec[] {
  const topBottomY = dims.height - dims.topThickness;
  const top = topBounds(dims.topWidth, dims.topDepth, dims.height, dims.topThickness);
  const parts: ComponentSpec[] = [
    ...panel({
      id: "desk-top",
      name: "Tabletop",
      x: 0,
      y: topBottomY + dims.topThickness / 2,
      z: 0,
      width: dims.topWidth,
      height: dims.topThickness,
      depth: dims.topDepth,
      bevel: dims.bevel,
      material: materials.top,
    }),
  ];
  const rails = apronPair(
    top,
    dims.legWidth,
    dims.legDepth,
    dims.inset,
    dims.apronHeight,
    dims.apronThickness,
  );
  const railIds = ["desk-apron-front", "desk-apron-back"] as const;
  const railNames = ["Apron front", "Apron back"] as const;
  rails.forEach((rail, index) => {
    parts.push(
      ...panel({
        id: railIds[index] ?? `desk-apron-${index}`,
        name: railNames[index] ?? `Apron ${index}`,
        x: rail.center[0],
        y: rail.center[1],
        z: rail.center[2],
        width: rail.length,
        height: dims.apronHeight,
        depth: dims.apronThickness,
        material: materials.top,
      }),
    );
  });
  const span = verticalSpan(0, topBottomY);
  const legNames = ["front-left", "front-right", "back-left", "back-right"] as const;
  tableLegCenters(top, dims.legWidth, dims.legDepth, dims.inset).forEach(([x, z], index) => {
    parts.push(
      ...footedPost({
        id: `desk-leg-${legNames[index] ?? index}`,
        name: `Leg ${legNames[index] ?? index}`,
        x,
        z,
        baseY: 0,
        postWidth: dims.legWidth,
        postHeight: span.height,
        postDepth: dims.legDepth,
        footWidth: dims.legWidth + 0.04,
        footHeight: 0.04,
        footDepth: dims.legDepth + 0.04,
        material: materials.legs,
      }),
    );
  });
  return parts;
}

/**
 * Validate a desk plan and build it into a validated assembly: eleven parts
 * (top, two aprons, four legs with feet) through the existing component and
 * assembly path, so every invariant that path proves holds for desks too.
 */
export function buildDeskPlan(input: unknown): Result<AssembledObject, DeskPlanError> {
  const resolved = resolveDeskPlan(input);
  if (!resolved.ok) return resolved;
  const plan = resolved.value;
  let parts: ComponentSpec[];
  try {
    parts = deriveDeskParts(plan, { top: plan.top, legs: plan.legs });
  } catch (error) {
    return {
      ok: false,
      error: invalidPlan("(derived)", error instanceof Error ? error.message : String(error)),
    };
  }
  const built: BuiltComponent[] = [];
  for (const part of parts) {
    const result = buildComponent(part);
    if (!result.ok) return { ok: false, error: { ...result.error } };
    built.push(result.value);
  }
  const assembled = assembleComponents({ id: "desk", name: "Desk", components: built });
  if (!assembled.ok) return { ok: false, error: { ...assembled.error } };
  return { ok: true, value: assembled.value };
}

export type DeskChanges = {
  // Explicit `| undefined`: the tool schema may hand an absent key as an
  // explicit undefined, and under `exactOptionalPropertyTypes` that is a
  // different type from a missing key.
  topWidth?: number | undefined;
  topDepth?: number | undefined;
  height?: number | undefined;
  topMaterial?: DeskMaterialChoice | undefined;
  legMaterial?: DeskMaterialChoice | undefined;
};

/** Numeric drift guard: rebuilt floats within this of live values emit no ops. */
const REPLAN_EPSILON = 1e-9;

function closeEnough(first: number, second: number): boolean {
  return Math.abs(first - second) <= REPLAN_EPSILON;
}

const LEG_IDS = [
  "desk-leg-front-left",
  "desk-leg-front-right",
  "desk-leg-back-left",
  "desk-leg-back-right",
] as const;
const APRON_IDS = ["desk-apron-front", "desk-apron-back"] as const;

type BoxLeaf = Extract<SceneNode, { kind: "procedural"; op: "box" }>;

function notRepresentable(componentId: string, message: string): DeskPlanError {
  return { code: "not_representable", message, componentId };
}

/**
 * Demand one live part as a procedural box. A missing core part means the
 * scene is not a planner desk at all (`not_a_desk`); a present part of the
 * wrong shape cannot be reproduced by the planner (`not_representable`).
 */
function demandBox(byId: Map<string, SceneNode>, id: string): BoxLeaf | DeskPlanError {
  const node = byId.get(id);
  if (node === undefined) {
    return { code: "not_a_desk", message: `scene is missing planner part "${id}"` };
  }
  if (node.kind !== "procedural" || node.op !== "box") {
    return notRepresentable(id, `planner part "${id}" is not a procedural box`);
  }
  return node;
}

/**
 * Compare one live node against the planner's derivation for it: dimensions,
 * position, rotation, and scale must all agree within epsilon. Any divergence
 * — a moved apron, a shifted foot, a customized leg, a mirrored or rotated
 * part — means the scene no longer matches what the planner builds, and a
 * replan would silently overwrite the customization.
 */
function comparePart(
  live: SceneNode | undefined,
  expected: ComponentSpec,
): DeskPlanError | undefined {
  if (live === undefined) {
    return notRepresentable(expected.id, `scene is missing planner part "${expected.id}"`);
  }
  if (live.kind !== "procedural" || live.op !== "box") {
    return notRepresentable(expected.id, `planner part "${expected.id}" is not a procedural box`);
  }
  if (expected.op !== "box" || !("width" in expected.params)) {
    return notRepresentable(expected.id, `planner part "${expected.id}" is not a box part`);
  }
  for (const key of ["width", "height", "depth"] as const) {
    if (!closeEnough(live.params[key], expected.params[key])) {
      return notRepresentable(
        expected.id,
        `planner part "${expected.id}" has ${key} ${live.params[key]} m, ` +
          `but the planner layout needs ${expected.params[key]} m`,
      );
    }
  }
  const at = live.transform.position;
  const want = expected.transform.position;
  if (
    !closeEnough(at[0], want[0]) ||
    !closeEnough(at[1], want[1]) ||
    !closeEnough(at[2], want[2])
  ) {
    return notRepresentable(
      expected.id,
      `planner part "${expected.id}" is at [${at.join(", ")}], ` +
        `but the planner layout places it at [${want.join(", ")}]`,
    );
  }
  const turned = live.transform.rotationEuler;
  if (!turned.every((angle) => Math.abs(angle) <= REPLAN_EPSILON)) {
    return notRepresentable(
      expected.id,
      `planner part "${expected.id}" is rotated — the desk planner only edits axis-aligned desks`,
    );
  }
  const scaled = live.transform.scale;
  if (!scaled.every((factor) => Math.abs(factor - 1) <= REPLAN_EPSILON)) {
    return notRepresentable(
      expected.id,
      `planner part "${expected.id}" is rescaled — the desk planner only edits unit-scale desks`,
    );
  }
  return undefined;
}

/**
 * Recompute a planner-built desk against requested changes and diff it into
 * patch operations. Reads current dimensions from the live nodes and merges
 * the changes over them, so untouched values flow through verbatim and emit
 * nothing; every dependent of a changed dimension is recomputed, so one
 * atomic patch moves the whole desk coherently.
 */
export function replanDesk(
  spec: SceneSpec,
  changes: DeskChanges,
): Result<{ ops: PatchOp[]; summary: string[] }, DeskPlanError> {
  if (typeof changes !== "object" || changes === null) {
    return { ok: false, error: invalidPlan("(changes)", "must be an object") };
  }
  const known = ["topWidth", "topDepth", "height", "topMaterial", "legMaterial"];
  for (const key of Object.keys(changes)) {
    if (!known.includes(key)) {
      return { ok: false, error: invalidPlan(key, "unknown desk change") };
    }
  }
  const byId = new Map<string, SceneNode>(spec.nodes.map((node) => [node.id, node]));
  if (byId.get("desk-top") === undefined) {
    return {
      ok: false,
      error: {
        code: "not_a_desk",
        message: 'scene has no planner-built desk top ("desk-top")',
      },
    };
  }
  // The six core parts prove this is a planner desk; feet join the comparison
  // below, where a missing foot is a representability failure, not an absence.
  const parts = new Map<string, BoxLeaf>();
  for (const id of ["desk-top", ...LEG_IDS, ...APRON_IDS]) {
    const found = demandBox(byId, id);
    if ("code" in found) return { ok: false, error: found };
    parts.set(id, found);
  }
  // Narrowed up front by the loop above: no silent fallbacks below may
  // substitute defaults for geometry the scene actually carries.
  const need = (id: string): BoxLeaf => {
    const found = parts.get(id);
    if (found === undefined) {
      throw new Error(`internal error: pre-check missed planner part "${id}"`);
    }
    return found;
  };
  const top = need("desk-top");
  const legNode = need("desk-leg-front-left");
  const apronNode = need("desk-apron-front");
  const presentMaterials = new Map(spec.materials.map((material) => [material.id, material]));
  const pickMaterial = (
    change: DeskMaterialChoice | undefined,
    currentId: string,
    field: string,
    allowed: readonly string[],
  ): SceneMaterial | DeskPlanError => {
    if (change === undefined) {
      const current = presentMaterials.get(currentId);
      if (current === undefined) {
        return { code: "unknown_material", message: `scene has no material "${currentId}"` };
      }
      return current;
    }
    if (typeof change !== "object" || change === null || typeof change.material !== "string") {
      return invalidPlan(field, "must be an object with a material name");
    }
    if (!allowed.includes(change.material)) {
      return invalidPlan(
        field,
        `unsupported material "${change.material}" (available: ${allowed.join(", ")})`,
      );
    }
    const existing = presentMaterials.get(change.material);
    if (existing === undefined) {
      const available = [...presentMaterials.keys()].join(", ");
      return {
        code: "unknown_material",
        message: `"${change.material}" is not in this scene (available: ${available})`,
      };
    }
    return existing;
  };
  const topWidth = changes.topWidth ?? top.params.width;
  const topDepth = changes.topDepth ?? top.params.depth;
  // The top's center height plus half its thickness is the floor-to-top height
  // only because the planner builds axis-aligned parts — enforced below, so a
  // hand-rotated or rescaled top is refused rather than misread.
  const height = changes.height ?? top.transform.position[1] + top.params.height / 2;
  for (const [field, value] of [
    ["topWidth", topWidth],
    ["topDepth", topDepth],
    ["height", height],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return { ok: false, error: invalidPlan(field, "must be a positive finite number") };
    }
  }
  const topMaterial = pickMaterial(changes.topMaterial, top.materialId, "topMaterial", [
    ...TOP_MATERIALS,
  ]);
  if ("code" in topMaterial) return { ok: false, error: topMaterial };
  const legMaterial = pickMaterial(changes.legMaterial, legNode.materialId, "legMaterial", [
    ...LEG_MATERIALS,
  ]);
  if ("code" in legMaterial) return { ok: false, error: legMaterial };
  // Live dimensions read straight from the proven box parts — no defaults, no
  // guessing. The inset comes from one leg's X offset as a hypothesis; the
  // derive-and-compare below is what proves X/Z agreement and leg symmetry.
  const liveHeight = top.transform.position[1] + top.params.height / 2;
  const live = {
    topWidth: top.params.width,
    topDepth: top.params.depth,
    height: liveHeight,
    topThickness: top.params.height,
    legWidth: legNode.params.width,
    legDepth: legNode.params.depth,
    inset: Math.max(
      0,
      top.params.width / 2 - Math.abs(legNode.transform.position[0]) - legNode.params.width / 2,
    ),
    apronHeight: apronNode.params.height,
    apronThickness: apronNode.params.depth,
    bevel: top.params.bevel ?? 0,
  };
  // Derive-and-compare: rebuild the planner layout from the live dimensions
  // and require every derived part to match the live scene. A moved apron, a
  // shifted foot, a customized leg, a mirrored or rotated part — anything the
  // planner would silently overwrite — fails here with the part named.
  let reference: ComponentSpec[];
  try {
    reference = deriveDeskParts({ ...live }, { top: topMaterial, legs: legMaterial });
  } catch (error) {
    return {
      ok: false,
      error: notRepresentable(
        "desk-top",
        `live dimensions do not form a planner layout (${error instanceof Error ? error.message : String(error)})`,
      ),
    };
  }
  for (const part of reference) {
    const mismatch = comparePart(byId.get(part.id), part);
    if (mismatch !== undefined) return { ok: false, error: mismatch };
  }
  // Target dimensions: the requested changes merged over the live ones, so
  // untouched values — including customized leg and apron sizes — flow through
  // verbatim rather than resetting to defaults.
  const current = { ...live, topWidth, topDepth, height };
  let target: ComponentSpec[];
  try {
    target = deriveDeskParts({ ...current }, { top: topMaterial, legs: legMaterial });
  } catch (error) {
    return {
      ok: false,
      error: invalidPlan("(derived)", error instanceof Error ? error.message : String(error)),
    };
  }
  const ops: PatchOp[] = [];
  for (const part of target) {
    const node = byId.get(part.id);
    // Unreachable for planner-coherent scenes (the comparison above requires
    // every derived part), but a missing or replaced part must fail loudly
    // rather than vanish from the diff.
    if (node === undefined) {
      return {
        ok: false,
        error: notRepresentable(part.id, `scene is missing planner part "${part.id}"`),
      };
    }
    if (node.kind !== "procedural" || node.op !== "box") {
      return {
        ok: false,
        error: notRepresentable(part.id, `planner part "${part.id}" is not a procedural box`),
      };
    }
    if (part.op === "box" && node.op === "box" && "width" in part.params) {
      for (const key of ["width", "height", "depth"] as const) {
        if (!closeEnough(node.params[key], part.params[key])) {
          ops.push({ op: "set_param", nodeId: part.id, key, value: part.params[key] });
        }
      }
      const at = node.transform.position;
      const next = part.transform.position;
      if (
        !closeEnough(at[0], next[0]) ||
        !closeEnough(at[1], next[1]) ||
        !closeEnough(at[2], next[2])
      ) {
        ops.push({ op: "set_transform", nodeId: part.id, transform: part.transform });
      }
    }
    if (node.materialId !== part.material.id) {
      ops.push({ op: "set_material", nodeId: part.id, materialId: part.material.id });
    }
  }
  if (ops.length === 0) {
    return {
      ok: false,
      error: { code: "no_changes", message: "the requested changes move nothing" },
    };
  }
  return {
    ok: true,
    value: {
      ops,
      summary: describeReplan(live, current, top, legNode, topMaterial, legMaterial, ops),
    },
  };
}

/**
 * Before-to-after lines for what the edit changed, plus an operation count.
 * Dimensions and materials compare live values against the merged request, so
 * the summary reports intent (what the user asked to change) rather than
 * re-listing every dependent the diff moved.
 */
function describeReplan(
  live: {
    topWidth: number;
    topDepth: number;
    height: number;
  },
  merged: { topWidth: number; topDepth: number; height: number },
  top: BoxLeaf,
  legNode: BoxLeaf,
  topMaterial: SceneMaterial,
  legMaterial: SceneMaterial,
  ops: PatchOp[],
): string[] {
  const lines: string[] = [];
  const dimension = (label: string, before: number, after: number): void => {
    if (!closeEnough(before, after)) lines.push(`${label} ${before} m → ${after} m`);
  };
  dimension("top width", live.topWidth, merged.topWidth);
  dimension("top depth", live.topDepth, merged.topDepth);
  dimension("height", live.height, merged.height);
  if (top.materialId !== topMaterial.id) {
    lines.push(`top material ${top.materialId} → ${topMaterial.id}`);
  }
  if (legNode.materialId !== legMaterial.id) {
    lines.push(`leg material ${legNode.materialId} → ${legMaterial.id}`);
  }
  const parts = new Set<string>();
  for (const op of ops) {
    if ("nodeId" in op) parts.add(op.nodeId);
  }
  lines.push(`${ops.length} operation(s) across ${parts.size} part(s).`);
  return lines;
}
