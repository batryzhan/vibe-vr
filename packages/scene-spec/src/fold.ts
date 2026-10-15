/**
 * Event-folded scene state: the head revision derived from an ordered log.
 *
 * The event log is the authority; this module is how every reader agrees on
 * what it says. Given the same ordered sequence it always returns the same
 * head — a pure function over an array, no clocks, no randomness, no store.
 * It follows `foldJobs` (`packages/shared/src/job-state.ts:153`) in shape:
 * walk once, accumulate, resolve the phase (here: the head) at the end.
 *
 * Input shapes are owned here, not in `@vibe-vr/shared`. M2 maps them onto the
 * `NapEvent` union for transport; until then the fold is testable without the
 * event system, which is exactly what lets M1 stay runtime-free.
 *
 * Rules, in application order per event:
 * - `scene.rejected` carries diagnostics, not state — always ignored.
 * - `scene.updated` must verify three ways or it is skipped: the spec parses,
 *   its canonical hash equals the claimed `specHash`, and it links — null
 *   parent starts a chain, otherwise `parentHash` must name a seen revision.
 *   A skipped entry never bricks the fold; later valid entries still apply.
 * - Redelivery is idempotent: an update whose hash already heads the fold is
 *   a no-op. Two different specs off one parent resolve by order — later in
 *   the sequence wins. Both properties fall out of content addressing rather
 *   than special casing, and both are pinned by tests.
 * - `scene.reverted` resolves `toHash` against seen revisions and moves the
 *   head; unknown hashes are skipped. Revert adds no revision — history is
 *   preserved because nothing is ever removed.
 *
 * Deliberately not here (runtime responsibilities, documented for M2/M3):
 * authoritative acceptance under a lease, exactly-once execution (the system
 * does not guarantee it — idempotent redelivery plus content-hash dedupe is
 * what it does guarantee), cross-process ordering beyond `seq`, and truncated
 * windows (a fold starting mid-log has no genesis; that needs a snapshot
 * event, a future extension, not a silent rebase).
 */

import { hashSceneSpec } from "./revisions.ts";
import { type SceneSpec, validateSceneSpec } from "./schema.ts";

export type SceneLogEvent =
  | {
      type: "scene.updated";
      spec: unknown;
      parentHash: string | null;
      specHash: string;
      turnId: string;
    }
  | { type: "scene.reverted"; toHash: string; turnId: string }
  | { type: "scene.rejected"; diagnostics: string; turnId: string };

export type SceneHead = {
  spec: SceneSpec;
  hash: string;
};

/**
 * One accepted `scene.updated`, in log order, with the linkage the fold verified.
 *
 * The client materializes these into its revision history: same entries, same
 * order, same parent links — so the viewport's history and the authoritative
 * fold can never disagree about what happened. Rejected entries and reverts
 * leave no revision behind (a revert moves the head, which the fold reports
 * separately), and skipped entries never appear here at all.
 */
export type AcceptedSceneRevision = {
  spec: SceneSpec;
  hash: string;
  parentHash: string | null;
  turnId: string;
};

function walkSceneEvents(events: readonly SceneLogEvent[]): {
  entries: AcceptedSceneRevision[];
  head: SceneHead | null;
} {
  const seen = new Map<string, SceneSpec>();
  const entries: AcceptedSceneRevision[] = [];
  let head: SceneHead | null = null;

  for (const event of events) {
    if (event.type === "scene.rejected") continue;

    if (event.type === "scene.reverted") {
      const target = seen.get(event.toHash);
      if (target === undefined) continue;
      head = { spec: target, hash: event.toHash };
      continue;
    }

    const validated = validateSceneSpec(event.spec);
    if (!validated.ok) continue;
    if (hashSceneSpec(validated.value) !== event.specHash) continue;
    if (head !== null && event.specHash === head.hash) continue;

    if (event.parentHash === null) {
      // A second genesis mid-chain is a fork attempt, not a restart.
      if (head !== null) continue;
    } else if (!seen.has(event.parentHash)) {
      continue;
    }

    seen.set(event.specHash, validated.value);
    entries.push({
      spec: validated.value,
      hash: event.specHash,
      parentHash: event.parentHash,
      turnId: event.turnId,
    });
    head = { spec: validated.value, hash: event.specHash };
  }

  return { entries, head };
}

/** The head revision of the log, or null when no valid update exists. */
export function foldSceneSpec(events: readonly SceneLogEvent[]): SceneHead | null {
  return walkSceneEvents(events).head;
}

/**
 * Every accepted revision in log order. Same walk as the head fold, so the
 * chain and the head agree by construction — a client that materializes these
 * entries renders exactly the history the fold accepted, nothing it skipped.
 */
export function collectSceneChain(events: readonly SceneLogEvent[]): AcceptedSceneRevision[] {
  return walkSceneEvents(events).entries;
}
