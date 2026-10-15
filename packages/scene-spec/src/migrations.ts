/**
 * Schema version registry and migration entry points.
 *
 * Version 1 is the only schema in this slice. This module exists so the second
 * schema version has somewhere to go that is not scattered across call sites:
 * `migrateScene` is the single function that turns unknown input into a validated
 * current-version spec, and it fails closed on anything it does not recognize.
 */

import type { Result } from "@vibe-vr/shared/result";
import { SCENE_SPEC_VERSION } from "./limits.ts";
import { type SceneSpec, validateSceneSpec } from "./schema.ts";

export type MigrationError = {
  code: "not_an_object" | "missing_version" | "unsupported_version" | "invalid_spec";
  message: string;
};

/**
 * Accept unknown input and return a validated version-1 spec, migrating forward
 * when a registered migration exists. Version 1 input validates in place.
 */
export function migrateScene(input: unknown): Result<SceneSpec, MigrationError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: { code: "not_an_object", message: "a scene must be an object" } };
  }
  const version = (input as { version?: unknown }).version;
  if (version === undefined) {
    return {
      ok: false,
      error: { code: "missing_version", message: "a scene must declare its version" },
    };
  }
  if (version !== SCENE_SPEC_VERSION) {
    return {
      ok: false,
      error: {
        code: "unsupported_version",
        message: `unsupported scene version ${JSON.stringify(version)}; this build reads version ${SCENE_SPEC_VERSION}`,
      },
    };
  }
  const validated = validateSceneSpec(input);
  if (!validated.ok) {
    return { ok: false, error: { code: "invalid_spec", message: validated.error.message } };
  }
  return { ok: true, value: validated.value };
}
