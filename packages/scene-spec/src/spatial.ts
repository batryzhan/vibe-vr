/**
 * Deterministic spatial queries for the supported procedural scene geometry.
 *
 * Bounds are computed from the scene graph's full group transform chain. The
 * scene schema uses metres, Y-up and Three.js' right-handed coordinate system;
 * boxes and tapered cylinders are the only leaf geometries today, so both can
 * be bounded exactly without loading Three.js or a renderer.
 */

import type { SceneNode, SceneSpec } from "./schema.ts";

export type Vec3 = readonly [number, number, number];
export type Bounds3 = { min: Vec3; max: Vec3 };
export type SpatialNode = {
  id: string;
  name: string;
  type: "group" | "box" | "cylinder";
  parentId: string | null;
  position: Vec3;
  rotation: Vec3;
  bounds: Bounds3 | null;
  materialId: string | null;
  tags: readonly string[];
};

type Matrix4 = readonly number[];

const IDENTITY: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`spatial matrix index ${index} is out of bounds`);
  return value;
}

function localMatrix(node: SceneNode): Matrix4 {
  const [x, y, z] = node.transform.rotationEuler;
  const [sx, sy, sz] = node.transform.scale;
  const [px, py, pz] = node.transform.position;
  const cx = Math.cos(x);
  const sxr = Math.sin(x);
  const cy = Math.cos(y);
  const syr = Math.sin(y);
  const cz = Math.cos(z);
  const szr = Math.sin(z);

  // Match the procedural builder's Three.js-compatible Rx * Ry * Rz matrix.
  const rotation = [
    cy * cz,
    -cy * szr,
    syr,
    cx * szr + sxr * syr * cz,
    cx * cz - sxr * syr * szr,
    -sxr * cy,
    sxr * szr - cx * syr * cz,
    sxr * cz + cx * syr * szr,
    cx * cy,
  ];

  return [
    at(rotation, 0) * sx,
    at(rotation, 1) * sy,
    at(rotation, 2) * sz,
    px,
    at(rotation, 3) * sx,
    at(rotation, 4) * sy,
    at(rotation, 5) * sz,
    py,
    at(rotation, 6) * sx,
    at(rotation, 7) * sy,
    at(rotation, 8) * sz,
    pz,
    0,
    0,
    0,
    1,
  ];
}

function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const out = Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let k = 0; k < 4; k++) {
        const index = row * 4 + col;
        out[index] = at(out, index) + at(a, row * 4 + k) * at(b, k * 4 + col);
      }
    }
  }
  return out;
}

function boundsFor(node: SceneNode, world: Matrix4): Bounds3 | null {
  if (node.kind !== "procedural") return null;

  const center: [number, number, number] = [at(world, 3), at(world, 7), at(world, 11)];
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];

  if (node.op === "box") {
    const half = [node.params.width / 2, node.params.height / 2, node.params.depth / 2];
    for (let axis = 0; axis < 3; axis++) {
      let extent = 0;
      for (let component = 0; component < 3; component++) {
        extent += Math.abs(at(world, axis * 4 + component)) * at(half, component);
      }
      min[axis] = at(center, axis) - extent;
      max[axis] = at(center, axis) + extent;
    }
  } else {
    const halfHeight = node.params.height / 2;
    for (let axis = 0; axis < 3; axis++) {
      const verticalOffset = at(world, axis * 4 + 1) * halfHeight;
      const radialScale = Math.hypot(at(world, axis * 4), at(world, axis * 4 + 2));
      const topExtent = node.params.radiusTop * radialScale;
      const bottomExtent = node.params.radiusBottom * radialScale;
      min[axis] = Math.min(
        at(center, axis) + verticalOffset - topExtent,
        at(center, axis) - verticalOffset - bottomExtent,
      );
      max[axis] = Math.max(
        at(center, axis) + verticalOffset + topExtent,
        at(center, axis) - verticalOffset + bottomExtent,
      );
    }
  }

  return { min, max };
}

function intersectsParentBounds(spec: SceneSpec): Map<string, string> {
  const parentByChild = new Map<string, string>();
  for (const node of spec.nodes) {
    if (node.kind !== "group") continue;
    for (const childId of node.children) {
      // The validator rejects cycles. For scenes that attach a node more than
      // once, the first group in canonical node order is the renderer's stable
      // parent for spatial context.
      if (!parentByChild.has(childId)) parentByChild.set(childId, node.id);
    }
  }
  return parentByChild;
}

/** A compact, renderer-independent spatial index for a validated scene. */
export function buildSpatialIndex(spec: SceneSpec): SpatialNode[] {
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  const parentByChild = intersectsParentBounds(spec);
  const worldById = new Map<string, Matrix4>();
  const visiting = new Set<string>();

  const worldMatrix = (id: string): Matrix4 => {
    const cached = worldById.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (node === undefined || visiting.has(id)) return IDENTITY;
    visiting.add(id);
    const parentId = parentByChild.get(id);
    const parent = parentId === undefined ? IDENTITY : worldMatrix(parentId);
    const world = multiply(parent, localMatrix(node));
    visiting.delete(id);
    worldById.set(id, world);
    return world;
  };

  return spec.nodes.map((node) => {
    const world = worldMatrix(node.id);
    return {
      id: node.id,
      name: node.name,
      type: node.kind === "group" ? "group" : node.op,
      parentId: parentByChild.get(node.id) ?? null,
      position: [at(world, 3), at(world, 7), at(world, 11)],
      rotation: node.transform.rotationEuler,
      bounds: boundsFor(node, world),
      materialId: node.kind === "procedural" ? node.materialId : null,
      tags: node.tags ?? [],
    };
  });
}

/** Bounds enclosing all renderable objects; groups do not contribute geometry. */
export function sceneBounds(spec: SceneSpec): Bounds3 | null {
  const bounds = buildSpatialIndex(spec).flatMap((node) =>
    node.bounds === null ? [] : [node.bounds],
  );
  if (bounds.length === 0) return null;
  return {
    min: [
      Math.min(...bounds.map((entry) => entry.min[0])),
      Math.min(...bounds.map((entry) => entry.min[1])),
      Math.min(...bounds.map((entry) => entry.min[2])),
    ],
    max: [
      Math.max(...bounds.map((entry) => entry.max[0])),
      Math.max(...bounds.map((entry) => entry.max[1])),
      Math.max(...bounds.map((entry) => entry.max[2])),
    ],
  };
}

export function boundsIntersect(a: Bounds3, b: Bounds3): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/** True when every point in `inner` lies within `outer`, boundaries included. */
export function boundsContain(outer: Bounds3, inner: Bounds3): boolean {
  return (
    outer.min[0] <= inner.min[0] &&
    outer.max[0] >= inner.max[0] &&
    outer.min[1] <= inner.min[1] &&
    outer.max[1] >= inner.max[1] &&
    outer.min[2] <= inner.min[2] &&
    outer.max[2] >= inner.max[2]
  );
}

/** Minimum Euclidean gap between two AABBs (zero for touching or intersecting bounds). */
export function boundsDistance(a: Bounds3, b: Bounds3): number {
  const gap = (axis: 0 | 1 | 2) =>
    Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]);
  return Math.hypot(gap(0), gap(1), gap(2));
}

export function nearestSceneNode(
  index: readonly SpatialNode[],
  point: Vec3,
  options: { excludeId?: string; includeGroups?: boolean } = {},
): SpatialNode | null {
  return (
    index
      .filter(
        (node) =>
          node.id !== options.excludeId && (options.includeGroups === true || node.bounds !== null),
      )
      .map((node) => ({
        node,
        distance: Math.hypot(...node.position.map((value, axis) => value - at(point, axis))),
      }))
      .sort((a, b) => a.distance - b.distance || a.node.id.localeCompare(b.node.id))[0]?.node ??
    null
  );
}

/** A position for placing the object's lowest bound on a flat ground plane. */
export function groundPlacement(bounds: Bounds3, groundY = 0): number {
  return groundY - bounds.min[1];
}

/** The app's current renderer has a flat Y=0 floor and no terrain mesh to sample. */
export function sampleGroundHeight(_spec: SceneSpec, _x: number, _z: number): number {
  return 0;
}

export function formatBounds(bounds: Bounds3 | null): string {
  if (bounds === null) return "group";
  const format = (value: number) => Number(value.toFixed(3));
  return `min=[${bounds.min.map(format).join(",")}] max=[${bounds.max.map(format).join(",")}]`;
}
