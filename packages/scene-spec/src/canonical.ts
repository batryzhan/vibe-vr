/**
 * Deterministic canonical serialization for scene specifications.
 *
 * The revision hash must be stable for equivalent specs: same semantic content in,
 * same string out, regardless of the key order the caller built the object with.
 * Rules:
 * - Object keys sort lexicographically (byte order) at every level.
 * - Arrays keep their order — node order is semantic.
 * - Numbers serialize with JSON.stringify (shortest round-trip for IEEE-754 doubles),
 *   so equal binary doubles always produce equal text. Non-finite numbers are rejected:
 *   JSON would silently turn them into `null`, which would hash two different scenes
 *   identically.
 * - `-0` normalizes to `0` (JSON.stringify already does this).
 * - `undefined` values are rejected rather than dropped — a dropped key would make
 *   "absent" and "undefined" hash alike while Zod treats them differently.
 *
 * Determinism contract: equal canonical strings for equal IEEE-754 double sequences
 * in any engine implementing standard JSON number formatting. Cross-engine float
 * *computation* differences (e.g. different triangulation math) are out of scope —
 * the engine pins its own golden outputs instead (see @vibe-vr/procedural tests).
 */

export type CanonicalErrorCode = "non_finite_number" | "undefined_value" | "unsupported_value";

export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;
  readonly path: string;
  constructor(code: CanonicalErrorCode, path: string, message: string) {
    super(message);
    this.name = "CanonicalError";
    this.code = code;
    this.path = path;
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalError("non_finite_number", path, `${path} is not finite`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => serialize(entry, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const parts = entries.map(([key, entry]) => {
      if (entry === undefined) {
        throw new CanonicalError(
          "undefined_value",
          `${path}.${key}`,
          `${path}.${key} is undefined; omit the key instead`,
        );
      }
      return `${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`)}`;
    });
    return `{${parts.join(",")}}`;
  }
  throw new CanonicalError(
    "unsupported_value",
    path,
    `${path} has unsupported type ${typeof value}`,
  );
}
