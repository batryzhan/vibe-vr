import { hashSceneSpec } from "@vibe-vr/scene-spec/revisions";
import { towerSpec } from "@vibe-vr/scene-spec/tower";
import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installViewportTestShims } from "./test-shims.ts";
import { useSceneRevisions } from "./use-scene-revisions.ts";

installViewportTestShims();

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER_SESSION = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const TOWER_HASH = hashSceneSpec(towerSpec());

let nextSeq = 1;

function sceneUpdated(
  spec: unknown,
  parentHash: string | null,
  specHash: string,
  sessionId: string = SESSION,
): StoredEvent {
  return {
    type: "scene.updated",
    sessionId,
    turnId: "turn-1",
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { spec, parentHash, specHash },
  } as StoredEvent;
}

function widenedSpec() {
  const spec = towerSpec();
  const base = spec.nodes.find((node) => node.id === "base");
  if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
  base.params.width = 2.4;
  return spec;
}

/** A tower with a narrower middle: a remote edit on a different node than local width edits. */
function midNarrowedSpec() {
  const spec = towerSpec();
  const mid = spec.nodes.find((node) => node.id === "mid");
  if (mid?.kind !== "procedural" || mid.op !== "box") throw new Error("fixture changed shape");
  mid.params.width = 1.5;
  return spec;
}

/** A tower without the mid node: structurally incompatible with mid edits. */
function towerWithoutMid() {
  const spec = towerSpec();
  spec.nodes = spec.nodes.filter((node) => node.id !== "mid");
  const root = spec.nodes.find((node) => node.id === "tower");
  if (root?.kind !== "group") throw new Error("fixture changed shape");
  root.children = root.children.filter((id) => id !== "mid");
  return spec;
}

function sceneRejected(diagnostics: string): StoredEvent {
  return {
    type: "scene.rejected",
    sessionId: SESSION,
    turnId: "turn-1",
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { code: "stale_base", diagnostics },
  } as StoredEvent;
}

function toolNoise(): StoredEvent {
  return {
    type: "tool.call",
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { toolCallId: "c1", toolName: "read_file", input: { path: "x" } },
  } as StoredEvent;
}

const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

describe("useSceneRevisions with session events", () => {
  it("adopts a shared genesis over the local fixture without a conflict notice", () => {
    // Fresh mount shows the client-side fixture tower. The first shared
    // revision carries different content (a tower the agent modeled), so the
    // viewport replaces the placeholder exactly once — no duplicate genesis,
    // no conflict banner for content the user never authored.
    const wide = widenedSpec();
    const wideHash = hashSceneSpec(wide);
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );
    expect(result.current.head.specHash).toBe(TOWER_HASH);

    act(() => {
      rerender({ events: [sceneUpdated(wide, null, wideHash)] });
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.head.specHash).toBe(wideHash);
    expect(result.current.built?.bounds.min[0]).toBeCloseTo(-1.2, 10);
    expect(result.current.notice).toBe(null);
  });

  it("adopts the shared chain when the log carries scene revisions", () => {
    const wide = widenedSpec();
    const wideHash = hashSceneSpec(wide);
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({
        events: [
          sceneUpdated(towerSpec(), null, TOWER_HASH),
          toolNoise(),
          sceneUpdated(wide, TOWER_HASH, wideHash),
        ],
      });
    });

    // The tower content matches the local fixture, so no duplicate genesis:
    // two entries, head at the widened revision, bounds proving the build.
    expect(result.current.history).toHaveLength(2);
    expect(result.current.head.specHash).toBe(wideHash);
    expect(result.current.built?.bounds.min[0]).toBeCloseTo(-1.2, 10);
    expect(result.current.notice).toBe(null);
  });

  it("ignores replays: the same events twice change nothing", () => {
    const wide = widenedSpec();
    const events = [
      sceneUpdated(towerSpec(), null, TOWER_HASH),
      sceneUpdated(wide, TOWER_HASH, hashSceneSpec(wide)),
    ];
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({ events });
    });
    const firstHead = result.current.head.id;
    const firstLength = result.current.history.length;
    act(() => {
      rerender({ events: [...events] });
    });

    expect(result.current.history).toHaveLength(firstLength);
    expect(result.current.head.id).toBe(firstHead);
  });

  it("keeps local inspector edits across remote sync without duplicating shared revisions", () => {
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    // A local edit first: the overlay exists before any shared state arrives.
    act(() => {
      result.current.setWidth("mid", 1.5);
    });
    expect(result.current.history).toHaveLength(2);

    // The shared chain lands carrying the same tower genesis plus an agent edit
    // to a *different* node, so both survive: shared entries once each, the
    // local edit replayed on top.
    const shared = widenedSpec();
    const sharedHash = hashSceneSpec(shared);
    act(() => {
      rerender({
        events: [
          sceneUpdated(towerSpec(), null, TOWER_HASH),
          sceneUpdated(shared, TOWER_HASH, sharedHash),
        ],
      });
    });

    const hashes = result.current.history.map((revision) => revision.specHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes).toContain(sharedHash);
    const mid = result.current.head.spec.nodes.find((node) => node.id === "mid");
    if (mid?.kind !== "procedural" || mid.op !== "box") throw new Error("mid lost its shape");
    expect(mid.params.width).toBe(1.5);
    const base = result.current.head.spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("base lost its shape");
    expect(base.params.width).toBe(2.4);
  });

  it("skips invalid remote entries without breaking the chain", () => {
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({
        events: [
          sceneUpdated(towerSpec(), null, TOWER_HASH),
          sceneUpdated({ version: 999 }, TOWER_HASH, "f".repeat(64)),
        ],
      });
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.head.specHash).toBe(TOWER_HASH);
  });

  it("surfaces the latest rejection as a notice and clears it on edit", () => {
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({
        events: [
          sceneUpdated(towerSpec(), null, TOWER_HASH),
          sceneRejected("proposal targets an older revision"),
        ],
      });
    });
    expect(result.current.notice).toMatchObject({ kind: "rejected" });
    expect(result.current.notice?.text).toMatch(/older revision/);

    act(() => {
      result.current.setWidth("base", 2.4);
    });
    expect(result.current.notice).toBe(null);
  });

  it("preserves undo position across a sync that changes nothing", () => {
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({ events: [sceneUpdated(towerSpec(), null, TOWER_HASH)] });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.canUndo).toBe(false);
  });

  it("adopts a differing shared genesis when the local log is still pristine", () => {
    // Production reality: the tower fixture is client-only, so the first shared
    // revision carries different content. With no local edits to lose, adoption
    // replaces the fixture outright.
    const wide = widenedSpec();
    const wideHash = hashSceneSpec(wide);
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({ events: [sceneUpdated(wide, null, wideHash)] });
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.head.specHash).toBe(wideHash);
    expect(result.current.built?.bounds.min[0]).toBeCloseTo(-1.2, 10);
  });

  it("keeps local edits and reports a conflict when shared genesis differs", () => {
    // Genuinely incompatible lineage: the shared scene has no "mid" node, so
    // replaying the local mid edit would fail validation. Freeze and report
    // rather than adopt half a history or silently drop user work.
    const divergent = towerWithoutMid();
    const divergentHash = hashSceneSpec(divergent);
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      result.current.setWidth("mid", 1.5);
    });
    act(() => {
      rerender({ events: [sceneUpdated(divergent, null, divergentHash)] });
    });

    // Nothing silently lost, nothing silently adopted: the local edit still
    // heads the display and the conflict says exactly that.
    const mid = result.current.head.spec.nodes.find((node) => node.id === "mid");
    if (mid?.kind !== "procedural" || mid.op !== "box") throw new Error("mid lost its shape");
    expect(mid.params.width).toBe(1.5);
    expect(result.current.notice).toMatchObject({ kind: "conflict" });
    expect(result.current.notice?.text).toMatch(/differ/i);

    // Explicit user action adopts the shared scene.
    act(() => {
      result.current.adoptSharedScene();
    });
    expect(result.current.head.specHash).toBe(divergentHash);
    expect(result.current.notice).toBe(null);
  });

  it("materializes a duplicate inside one log exactly once", () => {
    // Redelivery carries the same bytes under the same hash: the fold skips an update
    // whose hash already heads it, so the viewport must show one revision, not two.
    const wide = widenedSpec();
    const wideHash = hashSceneSpec(wide);
    const genesis = sceneUpdated(towerSpec(), null, TOWER_HASH);
    const edit = sceneUpdated(wide, TOWER_HASH, wideHash);
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({ events: [genesis, edit] });
    });
    expect(result.current.history).toHaveLength(2);
    const headId = result.current.head.id;

    act(() => {
      rerender({ events: [genesis, edit, { ...edit }] });
    });

    expect(result.current.history).toHaveLength(2);
    expect(result.current.head.id).toBe(headId);
    expect(result.current.head.specHash).toBe(wideHash);
  });

  it("switching sessions resets to the new session's scene with no contamination", () => {
    // One hook, two projects: the second session's log must replace the first's history
    // outright rather than folding one project's revisions into another's view.
    const wideB = widenedSpec();
    const wideBHash = hashSceneSpec(wideB);
    const { result, rerender } = renderHook(
      ({ events, sessionId }) => useSceneRevisions({ events, sessionId }),
      {
        initialProps: { events: [] as StoredEvent[], sessionId: SESSION },
      },
    );

    act(() => {
      rerender({ events: [sceneUpdated(towerSpec(), null, TOWER_HASH)], sessionId: SESSION });
    });
    expect(result.current.head.specHash).toBe(TOWER_HASH);

    act(() => {
      rerender({
        events: [sceneUpdated(wideB, null, wideBHash, OTHER_SESSION)],
        sessionId: OTHER_SESSION,
      });
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.head.specHash).toBe(wideBHash);
    expect(result.current.history.map((revision) => revision.specHash)).not.toContain(TOWER_HASH);
    expect(result.current.notice).toBe(null);

    // Back to the first session with no events: the fixture tower, not the other scene.
    act(() => {
      rerender({ events: [], sessionId: SESSION });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.head.specHash).toBe(TOWER_HASH);
  });

  it("undo to shared state prunes the overlay; a later remote advance does not resurrect it", () => {
    // The overlay records operations, not specs, and parking the head back on shared state
    // drops them: redo still shows the parked edit locally (revisions are never deleted),
    // but the next remote sync rebuilds from the shared chain only.
    const { result, rerender } = renderHook(
      ({ events }) => useSceneRevisions({ events, sessionId: SESSION }),
      {
        initialProps: { events: [] as StoredEvent[] },
      },
    );

    act(() => {
      rerender({ events: [sceneUpdated(towerSpec(), null, TOWER_HASH)] });
    });
    act(() => {
      result.current.setWidth("base", 2.4);
    });
    expect(result.current.history).toHaveLength(2);

    act(() => {
      result.current.undo();
    });
    expect(result.current.head.specHash).toBe(TOWER_HASH);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.redo();
    });
    const parked = result.current.head.spec.nodes.find((node) => node.id === "base");
    if (parked?.kind !== "procedural" || parked.op !== "box")
      throw new Error("base lost its shape");
    expect(parked.params.width).toBe(2.4);

    act(() => {
      result.current.undo();
    });
    const narrow = midNarrowedSpec();
    const narrowHash = hashSceneSpec(narrow);
    act(() => {
      rerender({
        events: [
          sceneUpdated(towerSpec(), null, TOWER_HASH),
          sceneUpdated(narrow, TOWER_HASH, narrowHash),
        ],
      });
    });

    // The remote mid edit lands; the parked base edit does not come back with it.
    expect(result.current.history).toHaveLength(2);
    expect(result.current.head.specHash).toBe(narrowHash);
    const base = result.current.head.spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("base lost its shape");
    expect(base.params.width).toBe(2);
    const mid = result.current.head.spec.nodes.find((node) => node.id === "mid");
    if (mid?.kind !== "procedural" || mid.op !== "box") throw new Error("mid lost its shape");
    expect(mid.params.width).toBe(1.5);
  });
});
