/**
 * Scene tools' shared logic: reading the folded head and applying proposals.
 *
 * Both tools answer from the same authority — the event log folded by
 * `foldSceneSpec` — so `get_scene` can never describe a scene that
 * `propose_scene_patch` would reject as stale, except across the one boundary
 * that matters: appends still in flight. A turn's own accepted proposals land
 * in the caller-owned overlay (`sceneState`) first and reach the store through
 * the normal emit path, so a second proposal in the same turn validates against
 * the first one's result rather than racing its append.
 *
 * Nothing here touches the store, the bus, or a `seq`. Reading history and
 * emitting events are the caller's jobs (injected as `readSessionEvents` and
 * `emit`); this module maps between the two and speaks only in validated
 * results. An invalid stored event cannot corrupt the fold — triple
 * verification runs at the boundary on every read, not just on write.
 */

import type { SceneHead } from "@vibe-vr/scene-spec/fold";
import { validateProposal } from "@vibe-vr/scene-spec/proposal";
import { readSceneHead } from "@vibe-vr/scene-spec/scene-events";
import type { SceneSpec } from "@vibe-vr/scene-spec/schema";
import { buildSpatialIndex, formatBounds, sceneBounds } from "@vibe-vr/scene-spec/spatial";

/** Re-exported so agent-side import sites keep one address for scene reads. */
export { readSceneHead };

/**
 * The head as text the model can propose against: stable ids, full parameters
 * (an edit needs the numbers it is changing), and the hash proposals must cite.
 * Compact by construction — node lines, not pretty JSON — with the existing
 * output cap as the backstop for scenes that outgrow a turn.
 */
export function summarizeScene(head: SceneHead): string {
  const spatialById = new Map(buildSpatialIndex(head.spec).map((node) => [node.id, node]));
  const bounds = sceneBounds(head.spec);
  const lines = head.spec.nodes.map((node) => {
    const spatial = spatialById.get(node.id);
    const parent =
      spatial?.parentId === null || spatial?.parentId === undefined
        ? ""
        : ` parent=${spatial.parentId}`;
    const position = spatial?.position === undefined ? "" : ` @ [${spatial.position.join(", ")}]`;
    const rotation = ` rotation=[${node.transform.rotationEuler.join(", ")}]`;
    const nodeBounds = ` bounds=${formatBounds(spatial?.bounds ?? null)}`;
    const tags =
      node.tags === undefined || node.tags.length === 0 ? "" : ` tags=[${node.tags.join(", ")}]`;
    const metadata =
      node.metadata === undefined ? "" : ` metadata=${JSON.stringify(node.metadata)}`;
    if (node.kind === "group") {
      return `- ${node.id}: group "${node.name}" children=[${node.children.join(", ")}]${parent}${position}${rotation}${tags}${metadata}`;
    }
    return (
      `- ${node.id}: ${node.op} "${node.name}" ` +
      `params=${JSON.stringify(node.params)} material=${node.materialId}` +
      `${parent}${position}${rotation}${nodeBounds}${tags}${metadata}`
    );
  });
  // The short hash is for humans scanning a transcript; the full revision
  // hash is what a patch must cite as baseHash, so it travels in the output
  // too — a model shown only the prefix cannot form a valid proposal.
  return [
    `Scene ${head.hash.slice(0, 12)} (${head.spec.nodes.length} nodes; id=${head.spec.id}):`,
    `revision ${head.hash}`,
    `coordinates: right-handed, Y-up, metres; world bounds=${formatBounds(bounds)}`,
    ...lines,
  ].join("\n");
}

export type ProposalApplication =
  | { ok: true; spec: SceneSpec; specHash: string; parentHash: string | null; nodeCount: number }
  | { ok: false; code: string; diagnostics: string };

/**
 * Validates a proposal against the given head through the canonical path.
 * Returns data for the `scene.updated` event, or the rejection to record.
 */
export function applySceneProposal(head: SceneHead | null, proposal: unknown): ProposalApplication {
  // No local null-head guard: validateProposal owns the empty-log branch, so a
  // genesis proposal reaches the creation path instead of dying as no_base here.
  const validated = validateProposal(proposal, head === null ? null : head.spec);
  if (!validated.ok) {
    return { ok: false, code: validated.error.code, diagnostics: validated.error.message };
  }
  return {
    ok: true,
    spec: validated.value.spec,
    specHash: validated.value.specHash,
    // Null for genesis: the fold starts a chain on a null parent, and a second
    // null-parent entry later is skipped as a fork rather than a restart.
    parentHash: head?.hash ?? null,
    nodeCount: validated.value.spec.nodes.length,
  };
}
