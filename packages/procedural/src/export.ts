/**
 * Client-side GLB export and re-import validation.
 *
 * Export serializes the *built* scene through Three.js GLTFExporter — never a
 * hand-authored placeholder — and validation parses the bytes back through
 * GLTFLoader and compares bounding boxes. Both directions run without a WebGL
 * context: the exporter walks the object graph and the loader decodes buffers,
 * so the artifact tests below execute in plain Node. (The viewport needs a GPU
 * context to *draw*; producing and checking bytes does not.)
 *
 * Tolerance: GLB stores positions as float32. At scene magnitudes around 4 m the
 * float32 rounding is ~1e-7, so the 1e-4 absolute tolerance is generous by three
 * orders of magnitude while still catching any real dimensional error.
 */

import type { Result } from "@vibe-vr/shared/result";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Bounds } from "./build.ts";

/** Absolute per-axis tolerance in meters for bounds comparison. */
export const BOUNDS_TOLERANCE_M = 1e-4;

export type ExportError = {
  code: "empty_scene" | "export_failed" | "not_binary";
  message: string;
};

export type ReimportError = {
  code: "invalid_glb" | "parse_failed" | "empty_result";
  message: string;
};

/**
 * Serialize an object graph to binary GLB. Refuses empty groups up front: an
 * exporter that happily writes zero meshes would let invalid scenes "succeed".
 */
export async function exportGlb(object: THREE.Object3D): Promise<Result<Uint8Array, ExportError>> {
  if (object.children.length === 0) {
    return {
      ok: false,
      error: { code: "empty_scene", message: "nothing to export: the scene holds no meshes" },
    };
  }
  try {
    const exporter = new GLTFExporter();
    const produced = await exporter.parseAsync(object, { binary: true });
    if (!(produced instanceof ArrayBuffer)) {
      return {
        ok: false,
        error: { code: "not_binary", message: "the exporter did not produce binary GLB" },
      };
    }
    return { ok: true, value: new Uint8Array(produced) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "export_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Structural GLB check: magic `glTF`, version 2, well-formed header. */
export function isPlausibleGlb(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46)
    return false;
  const version =
    (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8) | ((bytes[6] ?? 0) << 16) | ((bytes[7] ?? 0) << 24);
  return version === 2;
}

export type ReimportedScene = {
  object: THREE.Group;
  bounds: Bounds;
  meshCount: number;
};

/**
 * Parse GLB bytes back into a scene graph. Takes a copy of the input buffer:
 * the loader requires a bare ArrayBuffer and the caller may hold a view.
 */
export async function reimportGlb(
  bytes: Uint8Array,
): Promise<Result<ReimportedScene, ReimportError>> {
  if (!isPlausibleGlb(bytes)) {
    return {
      ok: false,
      error: { code: "invalid_glb", message: "bytes are not a GLB (bad magic, version or length)" },
    };
  }
  try {
    const loader = new GLTFLoader();
    const exact = bytes.slice().buffer as ArrayBuffer;
    const gltf = await loader.parseAsync(exact, "");
    const object = gltf.scene as THREE.Group;
    let meshCount = 0;
    object.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshCount += 1;
    });
    if (meshCount === 0) {
      return {
        ok: false,
        error: { code: "empty_result", message: "the GLB parsed but holds no meshes" },
      };
    }
    return { ok: true, value: { object, bounds: objectBounds(object), meshCount } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "parse_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** World-space bounds of an object graph. */
export function objectBounds(object: THREE.Object3D): Bounds {
  const box = new THREE.Box3().setFromObject(object);
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

/** Per-axis absolute comparison against the documented tolerance. */
export function boundsMatch(
  actual: Bounds,
  expected: Bounds,
  tolerance: number = BOUNDS_TOLERANCE_M,
): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs((actual.min[axis] ?? 0) - (expected.min[axis] ?? 0)) > tolerance) return false;
    if (Math.abs((actual.max[axis] ?? 0) - (expected.max[axis] ?? 0)) > tolerance) return false;
  }
  return true;
}
