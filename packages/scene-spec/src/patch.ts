/**
 * Constrained scene patches.
 *
 * A patch is a small, closed-vocabulary edit against a known base revision: set a
 * parameter, replace a transform, swap a material, rename, add or remove a node.
 * There is deliberately no "run this script" operation — the agent and the
 * inspector speak the same language, and every sentence in it is validatable.
 *
 * Atomicity: `applyPatch` clones the input and works on the clone, so a patch
 * whose third operation fails returns an error and leaves the caller's scene
 * untouched. The result re-validates before it is returned.
 */

import type { Result } from "@vibe-vr/shared/result";
import { z } from "zod";
import { MAX_MATERIALS, MAX_PATCH_OPS } from "./limits.ts";
import {
  BoxParamsSchema,
  CylinderParamsSchema,
  MaterialSchema,
  NodeIdSchema,
  type SceneSpec,
  TransformSchema,
  validateSceneSpec,
} from "./schema.ts";

export const SetParamOpSchema = z.strictObject({
  op: z.literal("set_param"),
  nodeId: NodeIdSchema,
  key: z.string().min(1).max(32),
  value: z.number(),
});

export const SetTransformOpSchema = z.strictObject({
  op: z.literal("set_transform"),
  nodeId: NodeIdSchema,
  transform: TransformSchema,
});

export const SetMaterialOpSchema = z.strictObject({
  op: z.literal("set_material"),
  nodeId: NodeIdSchema,
  materialId: z.string().min(1).max(64),
});

export const RenameOpSchema = z.strictObject({
  op: z.literal("rename"),
  nodeId: NodeIdSchema,
  name: z.string().min(1).max(80),
});

export const RemoveNodeOpSchema = z.strictObject({
  op: z.literal("remove_node"),
  nodeId: NodeIdSchema,
});

export const PatchOpSchema = z.discriminatedUnion("op", [
  SetParamOpSchema,
  SetTransformOpSchema,
  SetMaterialOpSchema,
  RenameOpSchema,
  RemoveNodeOpSchema,
  z.strictObject({
    op: z.literal("add_material"),
    material: MaterialSchema,
  }),
  z.strictObject({
    op: z.literal("add_node"),
    parentId: NodeIdSchema,
    // The node arrives as unknown and is validated on insertion — an add carrying
    // a malformed node must fail the patch, not the patch parser.
    node: z.unknown(),
  }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const ScenePatchSchema = z.strictObject({
  baseRevision: z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a sha-256 hex hash" }),
  ops: z.array(PatchOpSchema).min(1).max(MAX_PATCH_OPS),
});
export type ScenePatch = z.infer<typeof ScenePatchSchema>;

/** Machine-readable reason for an `invalid_value` failure. */
export type PatchErrorReason = "not_integer" | "too_small" | "too_big" | "constraint";

export type PatchError = {
  code:
    | "invalid_patch"
    | "stale_base"
    | "unknown_node"
    | "unknown_parent"
    | "not_procedural"
    | "unknown_param"
    | "invalid_value"
    | "unknown_material"
    | "duplicate_material"
    | "duplicate_node_id"
    | "cannot_remove_root"
    | "invalid_result";
  message: string;
  /** Index of the failing operation in the patch. Absent only for whole-patch errors. */
  opIndex?: number | undefined;
  /** The failing parameter or node reference, e.g. `"width"` or `"desk-top"`. */
  path?: string | undefined;
  /** Why the value was rejected. Set for `invalid_value` failures. */
  reason?: PatchErrorReason | undefined;
};

/**
 * Parameters each operation exposes for editing. The inspector and the agent may
 * only address these keys — anything else is `unknown_param`, which keeps a renamed
 * internal field from silently becoming a no-op edit.
 */
const EDITABLE_PARAMS: Record<string, readonly string[]> = {
  box: ["width", "height", "depth", "bevel"],
  cylinder: ["radiusTop", "radiusBottom", "height", "radialSegments", "heightSegments"],
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Apply `patch` to `spec`, returning the new spec without mutating the input.
 * `baseHash` is the canonical hash the caller built the patch against; a mismatch
 * means another edit landed first and the patch is stale, not wrong.
 */
export function applyPatch(
  spec: SceneSpec,
  patch: ScenePatch,
  baseHash: string,
): Result<SceneSpec, PatchError> {
  if (patch.baseRevision !== baseHash) {
    return {
      ok: false,
      error: {
        code: "stale_base",
        message: `patch targets ${shortHash(patch.baseRevision)} but the scene is at ${shortHash(baseHash)}`,
      },
    };
  }

  // Deep clone up front: every failure path below returns before this draft escapes,
  // so the caller's spec is never partially modified.
  const draft: SceneSpec = structuredClone(spec);
  const byId = new Map(draft.nodes.map((node) => [node.id, node]));

  // The index travels centrally: every operation-level failure names the exact
  // operation to fix, including remove/add errors.
  for (const [opIndex, op] of patch.ops.entries()) {
    const failure = applyOp(draft, byId, op, opIndex);
    if (failure !== undefined) return { ok: false, error: failure };
  }

  const revalidated = validateSceneSpec(draft);
  if (!revalidated.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_result",
        message: `patch yields an invalid scene: ${revalidated.error.message}`,
      },
    };
  }
  return { ok: true, value: revalidated.value };
}

function applyOp(
  draft: SceneSpec,
  byId: Map<string, SceneSpec["nodes"][number]>,
  op: PatchOp,
  opIndex: number,
): PatchError | undefined {
  switch (op.op) {
    case "set_param": {
      const node = byId.get(op.nodeId);
      if (node === undefined) {
        return {
          code: "unknown_node",
          message: `node "${op.nodeId}" does not exist`,
          opIndex,
          path: op.nodeId,
        };
      }
      if (node.kind !== "procedural") {
        return {
          code: "not_procedural",
          message: `node "${op.nodeId}" has no editable parameters`,
          opIndex,
          path: op.nodeId,
        };
      }
      const editable = EDITABLE_PARAMS[node.op] ?? [];
      if (!editable.includes(op.key)) {
        return {
          code: "unknown_param",
          message:
            `"${op.key}" is not an editable parameter of ${node.op} ` +
            `(editable: ${editable.join(", ")})`,
          opIndex,
          path: op.key,
        };
      }
      if (!isFiniteNumber(op.value)) {
        return {
          code: "invalid_value",
          message: `"${op.key}" must be a finite number, got ${op.value}`,
          opIndex,
          path: op.key,
          reason: "constraint",
        };
      }
      // Validated against the real parameter schema for this operation, so the
      // op-level check can never drift from what the scene accepts — including
      // interactions between parameters, like shrinking a dimension below
      // twice the existing bevel.
      const params = { ...node.params, [op.key]: op.value };
      const parsed =
        node.op === "box"
          ? BoxParamsSchema.safeParse(params)
          : CylinderParamsSchema.safeParse(params);
      if (!parsed.success) {
        return {
          code: "invalid_value",
          message: describeParamIssue(op.key, op.value, parsed.error.issues[0]),
          opIndex,
          path: op.key,
          reason: toReason(parsed.error.issues[0]),
        };
      }
      (node.params as Record<string, unknown>)[op.key] = op.value;
      return undefined;
    }
    case "set_transform": {
      const node = byId.get(op.nodeId);
      if (node === undefined) {
        return {
          code: "unknown_node",
          message: `node "${op.nodeId}" does not exist`,
          opIndex,
          path: op.nodeId,
        };
      }
      node.transform = op.transform;
      return undefined;
    }
    case "set_material": {
      const node = byId.get(op.nodeId);
      if (node === undefined) {
        return {
          code: "unknown_node",
          message: `node "${op.nodeId}" does not exist`,
          opIndex,
          path: op.nodeId,
        };
      }
      if (node.kind !== "procedural") {
        return {
          code: "not_procedural",
          message: `node "${op.nodeId}" carries no material`,
          opIndex,
          path: op.nodeId,
        };
      }
      const available = draft.materials.map((material) => material.id);
      if (!available.includes(op.materialId)) {
        return {
          code: "unknown_material",
          message:
            `unknown material "${op.materialId}"` +
            (available.length > 0
              ? ` (available: ${available.join(", ")})`
              : " (the scene carries no materials)") +
            ` — add the material to the scene first, or pick one it already carries`,
          opIndex,
          path: "materialId",
        };
      }
      node.materialId = op.materialId;
      return undefined;
    }
    case "rename": {
      const node = byId.get(op.nodeId);
      if (node === undefined) {
        return {
          code: "unknown_node",
          message: `node "${op.nodeId}" does not exist`,
          opIndex,
          path: op.nodeId,
        };
      }
      node.name = op.name;
      return undefined;
    }
    case "remove_node": {
      const node = byId.get(op.nodeId);
      if (node === undefined) {
        return {
          code: "unknown_node",
          message: `node "${op.nodeId}" does not exist`,
          opIndex,
          path: op.nodeId,
        };
      }
      if (op.nodeId === draft.root) {
        return {
          code: "cannot_remove_root",
          message: "the root node cannot be removed",
          opIndex,
          path: op.nodeId,
        };
      }
      // Detach from every group first, then drop the subtree, so no dangling child
      // reference survives even if validation below were ever skipped.
      for (const other of draft.nodes) {
        if (other.kind === "group") {
          other.children = other.children.filter((childId) => childId !== op.nodeId);
        }
      }
      const doomed = new Set<string>([op.nodeId]);
      const stack = [node];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || current.kind !== "group") continue;
        for (const childId of current.children) {
          if (doomed.has(childId)) continue;
          doomed.add(childId);
          const child = byId.get(childId);
          if (child !== undefined) stack.push(child);
        }
      }
      draft.nodes = draft.nodes.filter((candidate) => !doomed.has(candidate.id));
      for (const id of doomed) byId.delete(id);
      return undefined;
    }
    case "add_material": {
      if (draft.materials.some((material) => material.id === op.material.id)) {
        return {
          code: "duplicate_material",
          message: `material id "${op.material.id}" already exists`,
          opIndex,
          path: op.material.id,
        };
      }
      if (draft.materials.length >= MAX_MATERIALS) {
        return {
          code: "invalid_value",
          message: `the scene already has the maximum of ${MAX_MATERIALS} materials`,
          opIndex,
          path: "materials",
          reason: "constraint",
        };
      }
      draft.materials.push(structuredClone(op.material));
      return undefined;
    }
    case "add_node": {
      const parent = byId.get(op.parentId);
      if (parent === undefined) {
        return {
          code: "unknown_parent",
          message: `parent "${op.parentId}" names no node`,
          opIndex,
          path: op.parentId,
        };
      }
      if (parent.kind !== "group") {
        return {
          code: "unknown_parent",
          message: `parent "${op.parentId}" is not a group`,
          opIndex,
          path: op.parentId,
        };
      }
      const parsed = validateSceneSpec({
        ...structuredClone(draft),
        nodes: [...structuredClone(draft.nodes), op.node],
      });
      if (!parsed.ok) {
        const duplicate =
          typeof op.node === "object" && op.node !== null && "id" in op.node
            ? String((op.node as { id: unknown }).id)
            : "?";
        if (byId.has(duplicate)) {
          return {
            code: "duplicate_node_id",
            message: `a node named "${duplicate}" already exists`,
            opIndex,
            path: duplicate,
          };
        }
        return {
          code: "invalid_value",
          message: `added node is invalid: ${parsed.error.message}`,
          opIndex,
          reason: "constraint",
        };
      }
      const added = parsed.value.nodes[parsed.value.nodes.length - 1];
      if (added === undefined) {
        return {
          code: "invalid_value",
          message: "added node vanished during validation",
          opIndex,
          reason: "constraint",
        };
      }
      draft.nodes.push(added);
      const stored = draft.nodes[draft.nodes.length - 1];
      if (stored === undefined) {
        return {
          code: "invalid_value",
          message: "added node vanished during validation",
          opIndex,
          reason: "constraint",
        };
      }
      byId.set(added.id, stored);
      parent.children.push(added.id);
      return undefined;
    }
  }
}

/**
 * Map a parameter-schema issue to a machine-readable reason: an `int` type
 * rejection is `not_integer`, range rejections map directly, and anything
 * else (refinements like the bevel bound) is a `constraint`.
 */
function toReason(issue: unknown): PatchErrorReason {
  const viewed = issue as
    | { code?: unknown; expected?: unknown; minimum?: unknown; maximum?: unknown }
    | undefined;
  if (viewed === undefined) return "constraint";
  if (viewed.code === "too_small") return "too_small";
  if (viewed.code === "too_big") return "too_big";
  if (viewed.code === "invalid_type" && viewed.expected === "int") return "not_integer";
  return "constraint";
}

/** Short corrective message for a rejected parameter value. */
function describeParamIssue(key: string, value: number, issue: unknown): string {
  const viewed = issue as
    | { code?: unknown; minimum?: unknown; maximum?: unknown; message?: unknown }
    | undefined;
  if (viewed?.code === "invalid_type") {
    return `"${key}" must be an integer, got ${value}`;
  }
  if (viewed?.code === "too_small" && typeof viewed.minimum === "number") {
    return `"${key}" must be at least ${viewed.minimum}, got ${value}`;
  }
  if (viewed?.code === "too_big" && typeof viewed.maximum === "number") {
    return `"${key}" must be at most ${viewed.maximum}, got ${value}`;
  }
  if (typeof viewed?.message === "string") return `"${key}" ${viewed.message}, got ${value}`;
  return `"${key}" is invalid, got ${value}`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
