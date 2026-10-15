/**
 * Stored events narrowed to the fold's input, and the head read from them.
 *
 * Lives here rather than beside the agent tools that first needed it: the
 * browser viewport folds the same log through the same function, and two
 * copies of a 15-line narrowing would drift the moment one of them grew a
 * fourth event type. Pure mapping plus the fold — no store, no bus, no `seq`.
 */

import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { foldSceneSpec, type SceneHead, type SceneLogEvent } from "./fold.ts";

/** Narrows stored events to the fold's input; everything else is not scene state. */
export function sceneLogEvents(events: readonly StoredEvent[]): SceneLogEvent[] {
  const out: SceneLogEvent[] = [];
  for (const event of events) {
    if (event.type === "scene.updated") {
      out.push({
        type: "scene.updated",
        spec: event.payload.spec,
        parentHash: event.payload.parentHash,
        specHash: event.payload.specHash,
        turnId: event.turnId,
      });
    } else if (event.type === "scene.reverted") {
      out.push({ type: "scene.reverted", toHash: event.payload.toHash, turnId: event.turnId });
    } else if (event.type === "scene.rejected") {
      out.push({
        type: "scene.rejected",
        diagnostics: event.payload.diagnostics,
        turnId: event.turnId,
      });
    }
  }
  return out;
}

/** The authoritative head for these events, or null when the log holds no scene. */
export function readSceneHead(events: readonly StoredEvent[]): SceneHead | null {
  return foldSceneSpec(sceneLogEvents(events));
}
