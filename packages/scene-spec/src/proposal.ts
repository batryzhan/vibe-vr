/**
 * The `SceneProposal` contract: the only geometry-bearing shape the model may emit.
 *
 * A proposal is an untrusted request, not an edit. It names the scene version it
 * was computed against (`baseHash`), a closed list of patch operations, and a
 * short human-readable rationale for the transcript. `validateProposal` checks
 * all three against the authoritative head and either returns a validated spec
 * or a machine-usable error the model can correct itself from — unknown node,
 * stale base with expected-vs-actual hashes, out-of-range parameter.
 *
 * What this module deliberately does not do: decide who may propose (admission),
 * hold the authoritative head across processes (the event log, folded), or
 * execute anything outside pure validation. Those are runtime responsibilities
 * with a lease and a store behind them; this file has neither and needs neither.
 */

import type { Result } from "@vibe-vr/shared/result";
import { z } from "zod";
import { canonicalize } from "./canonical.ts";
import { MAX_PATCH_OPS, MAX_SCENE_EVENT_BYTES } from "./limits.ts";
import { applyPatch, type PatchError, PatchOpSchema } from "./patch.ts";
import { hashSceneSpec } from "./revisions.ts";
import { type SceneSpec, SceneSpecSchema, validateSceneSpec } from "./schema.ts";

/** Lowercase SHA-256 hex. Canonical hashes are compared as strings, never rehashed. */
export const HashHexSchema = z.string().regex(/^[0-9a-f]{64}$/, { message: "must be sha-256 hex" });
export type HashHex = z.infer<typeof HashHexSchema>;

export const SceneProposalSchema = z.strictObject({
  baseHash: HashHexSchema.describe(
    "Revision hash from get_scene. The patch applies to this version only.",
  ),
  ops: z
    .array(PatchOpSchema)
    .min(1)
    .max(MAX_PATCH_OPS)
    .describe(
      "Closed-vocabulary edits: set_param, set_transform, set_material, rename, add_node, add_material, remove_node.",
    ),
  rationale: z
    .string()
    .min(1)
    .max(500)
    .describe("What this patch changes and why, in one or two sentences."),
});
export type SceneProposal = z.infer<typeof SceneProposalSchema>;

/**
 * A complete initial scene, for an empty log. Validated as a whole spec —
 * there is no base to patch against, so the patch vocabulary does not apply.
 * Structural disambiguation keeps both arms strict: a creation carries `spec`
 * and no `baseHash`/`ops`, an edit carries the reverse, and a shape carrying
 * both (or neither) matches nothing.
 */
export const CreateSceneSchema = z.strictObject({
  spec: SceneSpecSchema,
  rationale: z.string().min(1).max(500).describe("What this scene is, in one or two sentences."),
});

/**
 * Everything the model may propose about scene geometry. The edit arm comes
 * first so every input the previous contract accepted parses exactly as
 * before; creation shapes fail the edit arm (no `baseHash`/`ops`) and land here.
 */
export const AnySceneProposalSchema = z.union([SceneProposalSchema, CreateSceneSchema]);
export type AnySceneProposal = z.infer<typeof AnySceneProposalSchema>;

export type ProposalErrorCode =
  | "invalid_proposal"
  | "no_base"
  | "stale_base"
  | "scene_exists"
  | "payload_too_large"
  | "no_op"
  | PatchError["code"];

export type ProposalError = {
  code: ProposalErrorCode;
  message: string;
};

export type ValidatedProposal = {
  spec: SceneSpec;
  specHash: HashHex;
  /** Canonical bytes of the resulting spec — what would travel the log. */
  canonicalLength: number;
};

/**
 * Validate a proposal against the authoritative head.
 *
 * Order matters: shape first (unparseable input never reaches the store of
 * record), then the create/edit fork, then — per arm — liveness, freshness,
 * the patch itself through the same atomic path the inspector uses, size, and
 * emptiness. Each rejection names its cause; only a fully validated spec escapes.
 *
 * A creation against a non-empty head is rejected, never merged: two genesis
 * events cannot share one chain, and the fold would skip the second one
 * silently, so the refusal happens here where the diagnostics still reach
 * the model.
 */
export function validateProposal(
  proposal: unknown,
  head: SceneSpec | null,
): Result<ValidatedProposal, ProposalError> {
  const parsed = SceneProposalSchema.safeParse(proposal);
  if (parsed.success) return validateEdit(parsed.data, head);

  const created = CreateSceneSchema.safeParse(proposal);
  if (!created.success) {
    return {
      ok: false,
      error: {
        code: "invalid_proposal",
        message: created.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      },
    };
  }
  return validateCreation(created.data, head);
}

/** The pre-existing edit path, unchanged: base hash, atomic patch, size, no-op. */
function validateEdit(
  proposal: SceneProposal,
  head: SceneSpec | null,
): Result<ValidatedProposal, ProposalError> {
  if (head === null) {
    return { ok: false, error: { code: "no_base", message: "there is no scene to patch yet" } };
  }

  const headHash = hashSceneSpec(head);
  if (proposal.baseHash !== headHash) {
    return {
      ok: false,
      error: {
        code: "stale_base",
        message:
          `stale base: proposal targets ${shortHash(proposal.baseHash)} but the scene is at ${shortHash(headHash)}; ` +
          `re-read the scene and propose again`,
      },
    };
  }

  const applied = applyPatch(
    head,
    { baseRevision: proposal.baseHash, ops: proposal.ops },
    headHash,
  );
  if (!applied.ok) return { ok: false, error: applied.error };

  return checkSizeAndNovelty(applied.value, proposal.baseHash);
}

/** A complete genesis spec against an empty log. */
function validateCreation(
  proposal: z.infer<typeof CreateSceneSchema>,
  head: SceneSpec | null,
): Result<ValidatedProposal, ProposalError> {
  if (head !== null) {
    return {
      ok: false,
      error: {
        code: "scene_exists",
        message:
          `a scene already exists at ${shortHash(hashSceneSpec(head))}; ` +
          `propose an edit against it instead of a new scene`,
      },
    };
  }

  const validated = validateSceneSpec(proposal.spec);
  if (!validated.ok) {
    return {
      ok: false,
      error: { code: "invalid_proposal", message: `spec: ${validated.error.message}` },
    };
  }

  return checkSizeAndNovelty(validated.value, null);
}

/** Shared tail: transport size gate, then the hash the event will carry. */
function checkSizeAndNovelty(
  spec: SceneSpec,
  baseHash: string | null,
): Result<ValidatedProposal, ProposalError> {
  const canonicalLength = canonicalize(spec).length;
  if (canonicalLength > MAX_SCENE_EVENT_BYTES) {
    return {
      ok: false,
      error: {
        code: "payload_too_large",
        message: `resulting scene is ${canonicalLength} bytes, over the ${MAX_SCENE_EVENT_BYTES}-byte log limit`,
      },
    };
  }

  const specHash = hashSceneSpec(spec);
  if (baseHash !== null && specHash === baseHash) {
    return {
      ok: false,
      error: { code: "no_op", message: "the proposal changes nothing; no revision created" },
    };
  }

  return { ok: true, value: { spec, specHash, canonicalLength } };
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
