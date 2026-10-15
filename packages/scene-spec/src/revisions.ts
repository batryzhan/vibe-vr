/**
 * Immutable, parent-linked scene revisions.
 *
 * Every accepted edit produces a new revision that points at its parent; nothing is
 * ever mutated in place. Undo is therefore selection, not reversal: it moves the
 * head pointer back to the parent revision, whose spec and hash are byte-identical
 * to what they were. History is append-only, which is what makes "reapplying the
 * same state produces the same hash" a property rather than a hope.
 *
 * Persistence is deliberately out of scope for the first slice: the revision log
 * below is in-memory and owned by the web workspace. The revision shape itself —
 * parent links, content hashes, stable ids — is what a future database migration
 * will store, so nothing about this contract needs to change when it does.
 */

import type { Result } from "@vibe-vr/shared/result";
import { canonicalize } from "./canonical.ts";
import { sha256Hex, utf8Bytes } from "./hash.ts";
import { type SceneSpec, validateSceneSpec } from "./schema.ts";

export type RevisionAuthor = {
  kind: "user" | "system";
  label: string;
};

export type SceneRevision = {
  /** Random id — identity. Content addressing is `specHash`, kept separate. */
  id: string;
  sceneId: string;
  parentId: string | null;
  specHash: string;
  spec: SceneSpec;
  author: RevisionAuthor;
  createdAt: string;
};

export type RevisionError = {
  code: "invalid_spec" | "unknown_parent" | "parent_mismatch";
  message: string;
};

/** Canonical SHA-256 hash of a validated spec. */
export function hashSceneSpec(spec: SceneSpec): string {
  return sha256Hex(utf8Bytes(canonicalize(spec)));
}

/**
 * Create the genesis revision for a new scene: no parent, validated spec, fresh hash.
 */
export function createGenesisRevision(options: {
  sceneId: string;
  spec: unknown;
  author: RevisionAuthor;
}): Result<SceneRevision, RevisionError> {
  const validated = validateSceneSpec(options.spec);
  if (!validated.ok) {
    return { ok: false, error: { code: "invalid_spec", message: validated.error.message } };
  }
  return {
    ok: true,
    value: {
      id: crypto.randomUUID(),
      sceneId: options.sceneId,
      parentId: null,
      specHash: hashSceneSpec(validated.value),
      spec: validated.value,
      author: options.author,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * Create a child revision. The parent's stored hash is recomputed rather than
 * trusted, so a corrupted in-memory parent fails here instead of forking history.
 */
export function createChildRevision(options: {
  sceneId: string;
  parent: SceneRevision;
  spec: unknown;
  author: RevisionAuthor;
}): Result<SceneRevision, RevisionError> {
  const validated = validateSceneSpec(options.spec);
  if (!validated.ok) {
    return { ok: false, error: { code: "invalid_spec", message: validated.error.message } };
  }
  if (hashSceneSpec(options.parent.spec) !== options.parent.specHash) {
    return {
      ok: false,
      error: {
        code: "parent_mismatch",
        message: "the parent revision's spec does not match its hash",
      },
    };
  }
  return {
    ok: true,
    value: {
      id: crypto.randomUUID(),
      sceneId: options.sceneId,
      parentId: options.parent.id,
      specHash: hashSceneSpec(validated.value),
      spec: validated.value,
      author: options.author,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * Append-only in-memory history. `undo` returns the parent revision (or null at
 * genesis) and keeps every revision reachable — redo is following the child link
 * the log already kept.
 */
export class RevisionLog {
  private readonly revisions = new Map<string, SceneRevision>();
  private headId: string;

  private constructor(genesis: SceneRevision) {
    this.revisions.set(genesis.id, genesis);
    this.headId = genesis.id;
  }

  static begin(genesis: SceneRevision): RevisionLog {
    return new RevisionLog(genesis);
  }

  head(): SceneRevision {
    const head = this.revisions.get(this.headId);
    if (head === undefined) throw new Error("revision log lost its head");
    return head;
  }

  append(revision: SceneRevision): void {
    if (revision.parentId !== this.headId) {
      throw new Error("can only append a child of the current head");
    }
    this.revisions.set(revision.id, revision);
    this.headId = revision.id;
  }

  /** Move the head to the parent revision. Returns null at genesis. */
  undo(): SceneRevision | null {
    const head = this.head();
    if (head.parentId === null) return null;
    const parent = this.revisions.get(head.parentId);
    if (parent === undefined) throw new Error("revision log lost a parent");
    this.headId = parent.id;
    return parent;
  }

  /** Whether the head has a recorded child to redo to. */
  canRedo(): boolean {
    for (const revision of this.revisions.values()) {
      if (revision.parentId === this.headId) return true;
    }
    return false;
  }

  /** Move the head forward to a direct child, if this log has one recorded. */
  redo(): SceneRevision | null {
    const headId = this.headId;
    for (const revision of this.revisions.values()) {
      if (revision.parentId === headId) {
        this.headId = revision.id;
        return revision;
      }
    }
    return null;
  }

  get(id: string): SceneRevision | undefined {
    return this.revisions.get(id);
  }

  history(): SceneRevision[] {
    const chain: SceneRevision[] = [];
    let current: SceneRevision | undefined = this.head();
    while (current !== undefined) {
      chain.unshift(current);
      current = current.parentId === null ? undefined : this.revisions.get(current.parentId);
    }
    return chain;
  }
}
