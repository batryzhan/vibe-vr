import { towerSpec } from "@vibe-vr/scene-spec/tower";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildScene } from "./build.ts";
import {
  BOUNDS_TOLERANCE_M,
  boundsMatch,
  exportGlb,
  isPlausibleGlb,
  objectBounds,
  reimportGlb,
} from "./export.ts";
import { builtSceneToGroup, disposeGroup } from "./three-adapter.ts";

/**
 * Node 24 ships Blob but not FileReader, and Three.js GLTFExporter assembles the
 * binary GLB by reading Blobs through FileReader — even with no images involved.
 * This shim delegates to the real Blob bytes, so the exporter, the bytes and the
 * loader under test are all genuine; only the missing platform global is filled
 * in. It is referenced through `globalThis` (never by bare name) so this package
 * keeps its deliberately narrow Node-only ambient types. Browsers (and the
 * viewport export path) never touch this code.
 */
type FileReaderSlot = {
  result: ArrayBuffer | string | null;
  onloadend: (() => void) | null;
  onerror: (() => void) | null;
  readAsArrayBuffer: (blob: Blob) => void;
  readAsDataURL: (blob: Blob) => void;
};
const fileReaderGlobal = globalThis as unknown as { FileReader?: new () => FileReaderSlot };
if (typeof fileReaderGlobal.FileReader === "undefined") {
  class NodeFileReader implements FileReaderSlot {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = buffer;
          this.onloadend?.();
        })
        .catch(() => this.onerror?.());
    }
    readAsDataURL(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buffer) => {
          const base64 = Buffer.from(buffer).toString("base64");
          this.result = `data:${blob.type || "application/octet-stream"};base64,${base64}`;
          this.onloadend?.();
        })
        .catch(() => this.onerror?.());
    }
  }
  fileReaderGlobal.FileReader = NodeFileReader;
}

const EXPECTED_TOWER = {
  min: [-1, 0, -1] as [number, number, number],
  max: [1, 4, 1] as [number, number, number],
};

async function towerGlb(): Promise<Uint8Array> {
  const built = buildScene(towerSpec());
  if (!built.ok) throw new Error(`fixture failed to build: ${built.error.message}`);
  const group = builtSceneToGroup(built.value);
  try {
    const exported = await exportGlb(group);
    if (!exported.ok) throw new Error(`export failed: ${exported.error.message}`);
    return exported.value;
  } finally {
    disposeGroup(group);
  }
}

describe("GLB export and re-import", () => {
  it("exports binary GLB with the glTF magic and version 2", async () => {
    const bytes = await towerGlb();
    expect(bytes.length).toBeGreaterThan(12);
    expect(isPlausibleGlb(bytes)).toBe(true);
  });

  it("re-imports to the expected tower bounds", async () => {
    const bytes = await towerGlb();
    const reimported = await reimportGlb(bytes);
    expect(reimported.ok).toBe(true);
    if (!reimported.ok) return;
    expect(reimported.value.meshCount).toBe(3);
    expect(boundsMatch(reimported.value.bounds, EXPECTED_TOWER)).toBe(true);
  });

  it("reflects a +20% width increase in the re-imported bounds", async () => {
    const spec = towerSpec();
    const base = spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
    base.params.width = 2.4;
    const built = buildScene(spec);
    if (!built.ok) throw new Error("edited scene failed to build");
    const group = builtSceneToGroup(built.value);
    try {
      const exported = await exportGlb(group);
      if (!exported.ok) throw new Error("export failed");
      const reimported = await reimportGlb(exported.value);
      if (!reimported.ok) throw new Error("re-import failed");
      expect(
        boundsMatch(reimported.value.bounds, {
          min: [-1.2, 0, -1],
          max: [1.2, 4, 1],
        }),
      ).toBe(true);
    } finally {
      disposeGroup(group);
    }
  });

  it("refuses to export an empty scene instead of writing zero meshes", async () => {
    const result = await exportGlb(new THREE.Group());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("empty_scene");
  });

  it("rejects non-GLB bytes at the plausibility gate", async () => {
    expect(isPlausibleGlb(new Uint8Array(0))).toBe(false);
    expect(isPlausibleGlb(new TextEncoder().encode("definitely not a glb file"))).toBe(false);
    const truncated = (await towerGlb()).slice(0, 8);
    expect(isPlausibleGlb(truncated)).toBe(false);
    const parsed = await reimportGlb(new TextEncoder().encode("not a glb at all!!!!"));
    expect(parsed.ok).toBe(false);
  });

  it("detects bounds mismatches beyond tolerance", () => {
    expect(boundsMatch(EXPECTED_TOWER, EXPECTED_TOWER)).toBe(true);
    expect(boundsMatch({ min: [-1.2, 0, -1], max: [1.2, 4, 1] }, EXPECTED_TOWER)).toBe(false);
    // A drift of exactly the tolerance passes; anything clearly above it fails.
    expect(
      boundsMatch({ min: [-1 - BOUNDS_TOLERANCE_M * 2, 0, -1], max: [1, 4, 1] }, EXPECTED_TOWER),
    ).toBe(false);
  });

  it("adapter meshes sit at identity with baked vertices", async () => {
    const built = buildScene(towerSpec());
    if (!built.ok) throw new Error("fixture failed to build");
    const group = builtSceneToGroup(built.value);
    try {
      for (const child of group.children) {
        expect(child.position.length()).toBe(0);
        expect(child.quaternion.equals(new THREE.Quaternion())).toBe(true);
      }
      const bounds = objectBounds(group);
      expect(boundsMatch(bounds, EXPECTED_TOWER)).toBe(true);
    } finally {
      disposeGroup(group);
    }
  });

  it("disposeGroup releases geometries and materials", () => {
    const built = buildScene(towerSpec());
    if (!built.ok) throw new Error("fixture failed to build");
    const group = builtSceneToGroup(built.value);
    const meshes = [...group.children] as THREE.Mesh[];
    expect(meshes).toHaveLength(3);
    let disposed = 0;
    for (const mesh of meshes) {
      mesh.geometry.addEventListener("dispose", () => {
        disposed += 1;
      });
      const material = mesh.material as THREE.Material;
      material.addEventListener("dispose", () => {
        disposed += 1;
      });
    }
    disposeGroup(group);
    expect(group.children).toHaveLength(0);
    // 3 geometries + 3 materials each fire their dispose event.
    expect(disposed).toBe(6);
  });
});
