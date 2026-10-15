import { describe, expect, it } from "vitest";
import type { SceneSpec } from "./schema.ts";
import {
  boundsContain,
  boundsDistance,
  boundsIntersect,
  buildSpatialIndex,
  groundPlacement,
  nearestSceneNode,
  sampleGroundHeight,
  sceneBounds,
} from "./spatial.ts";

const scene: SceneSpec = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000001",
  seed: 2,
  units: "m",
  axes: "y-up",
  root: "root",
  materials: [{ id: "wood", name: "Wood", color: "#886644", metalness: 0, roughness: 0.7 }],
  nodes: [
    {
      kind: "group",
      id: "root",
      name: "Root",
      transform: { position: [10, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      children: ["box", "post"],
    },
    {
      kind: "procedural",
      op: "box",
      id: "box",
      name: "Box",
      transform: { position: [1, 1, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      params: { width: 2, height: 2, depth: 2 },
      materialId: "wood",
      seed: 1,
      tags: ["furniture"],
    },
    {
      kind: "procedural",
      op: "cylinder",
      id: "post",
      name: "Post",
      transform: { position: [-3, 0.5, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      params: {
        radiusTop: 0.5,
        radiusBottom: 0.5,
        height: 1,
        radialSegments: 8,
        heightSegments: 1,
        capped: true,
      },
      materialId: "wood",
      seed: 1,
    },
  ],
};

describe("scene spatial queries", () => {
  it("computes renderer-world bounds through group transforms and includes node metadata", () => {
    const index = buildSpatialIndex(scene);
    const box = index.find((node) => node.id === "box");
    expect(box).toMatchObject({
      parentId: "root",
      position: [11, 1, 0],
      bounds: { min: [10, 0, -1], max: [12, 2, 1] },
      tags: ["furniture"],
    });
    expect(sceneBounds(scene)).toEqual({ min: [6.5, 0, -1], max: [12, 2, 1] });
  });

  it("answers intersection, containment, gap distance and nearest-object queries", () => {
    const a = { min: [0, 0, 0] as const, max: [1, 1, 1] as const };
    const touching = { min: [1, 0, 0] as const, max: [2, 1, 1] as const };
    const far = { min: [4, 0, 0] as const, max: [5, 1, 1] as const };
    expect(boundsIntersect(a, touching)).toBe(true);
    expect(boundsContain({ min: [-1, -1, -1], max: [2, 2, 2] }, a)).toBe(true);
    expect(boundsDistance(a, far)).toBe(3);
    expect(nearestSceneNode(buildSpatialIndex(scene), [10, 1, 0])?.id).toBe("box");
  });

  it("places the lowest bound on the flat floor supported by the renderer", () => {
    const item = buildSpatialIndex(scene).find((node) => node.id === "box")!;
    expect(groundPlacement(item.bounds!, 0)).toBe(0);
    expect(sampleGroundHeight(scene, 100, -50)).toBe(0);
  });
});
