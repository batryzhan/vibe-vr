"use client";

/**
 * Scene revision state for the 3D viewport.
 *
 * Two writers feed one history. Local inspector edits append to the revision
 * log directly, exactly as before. Shared revisions arrive through the
 * session's event log and are merged in: verified through the same fold the
 * worker uses, materialized with content-hash ids so redelivery can never
 * duplicate them, and never silently overwriting local work.
 *
 * Authority stays where the architecture puts it: the event log. The agent
 * validates proposals against the folded head, never against this pane, so a
 * display that runs ahead only risks a stale-base rejection — which surfaces
 * as a notice, not a fork. What this hook must never do is invent history:
 * every remote revision it shows was accepted by the fold, in log order.
 */

import { type BuiltScene, buildScene } from "@vibe-vr/procedural/build";
import { boundsMatch, exportGlb, reimportGlb } from "@vibe-vr/procedural/export";
import { builtSceneToGroup, disposeGroup } from "@vibe-vr/procedural/three-adapter";
import { type AcceptedSceneRevision, collectSceneChain, foldSceneSpec } from "@vibe-vr/scene-spec/fold";
import { MAX_DIMENSION_M, MIN_DIMENSION_M } from "@vibe-vr/scene-spec/limits";
import { applyPatch, type PatchOp } from "@vibe-vr/scene-spec/patch";
import {
  createChildRevision,
  createGenesisRevision,
  hashSceneSpec,
  RevisionLog,
  type SceneRevision,
} from "@vibe-vr/scene-spec/revisions";
import { sceneLogEvents } from "@vibe-vr/scene-spec/scene-events";
import { validateSceneSpec } from "@vibe-vr/scene-spec/schema";
import { towerSpec } from "@vibe-vr/scene-spec/tower";
import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ExportStatus =
  | { state: "idle" }
  | { state: "exporting" }
  | {
      state: "ready";
      /** Short hash of the revision these bytes were built from. */
      forRevision: string;
      /** Whether the head has moved on since the export finished. */
      current: boolean;
      byteLength: number;
      meshCount: number;
      downloadUrl: string;
    }
  | { state: "error"; message: string };

export type SceneController = {
  head: SceneRevision;
  history: SceneRevision[];
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  built: BuiltScene | null;
  buildError: string | null;
  editError: string | null;
  /**
   * Human-readable shared-state signal, or null when there is nothing to say.
   * Rejected proposals and sync conflicts surface here; the transcript already
   * carries the tool results, so this pane says it once, in its own words.
   */
  notice: { kind: "rejected" | "conflict"; text: string } | null;
  /** GLB export lifecycle for the head revision's current-or-stale display. */
  exportStatus: ExportStatus;
  select: (id: string | null) => void;
  setWidth: (nodeId: string, width: number) => void;
  undo: () => void;
  redo: () => void;
  adoptSharedScene: () => void;
  exportAndValidate: () => Promise<void>;
};

export type SceneRevisionsOptions = {
  /** Session log events. Absent means standalone mode: the fixture only. */
  events?: readonly StoredEvent[];
  /** Identifies synthesized revisions with the session whose log they came from. */
  sessionId?: string;
};

/**
 * Materialize one accepted remote revision for the log. Mirrors
 * `createChildRevision`'s checks — validated spec, verified hash, resolvable
 * parent — because transported events are untrusted input at this boundary,
 * exactly as they are at the fold.
 */
function toRevision(
  entry: AcceptedSceneRevision,
  parentId: string | null,
  sceneId: string,
  createdAt: string,
): SceneRevision | null {
  const validated = validateSceneSpec(entry.spec);
  if (!validated.ok) return null;
  if (hashSceneSpec(validated.value) !== entry.hash) return null;
  return {
    id: entry.hash,
    sceneId,
    parentId,
    specHash: entry.hash,
    spec: validated.value,
    author: { kind: "system", label: "agent" },
    createdAt,
  };
}

/**
 * The shared side of a sync, derived fresh from the event prop every time.
 * Nothing here is stored: the log object stays the only stateful structure,
 * so there is no second copy of history to drift out of agreement with it.
 */
type RemoteView = {
  chain: AcceptedSceneRevision[];
  headHash: string | null;
  remoteHashes: Set<string>;
  createdAt: Map<string, string>;
  lastRejected: { seq: number; diagnostics: string } | null;
  lastUpdateSeq: number;
};

function viewRemoteEvents(events: readonly StoredEvent[]): RemoteView {
  const narrowed = sceneLogEvents(events);
  const chain = collectSceneChain(narrowed);
  const head = foldSceneSpec(narrowed);
  const remoteHashes = new Set(chain.map((entry) => entry.hash));
  const createdAt = new Map<string, string>();
  let lastUpdateSeq = -1;
  let lastRejected: RemoteView["lastRejected"] = null;
  for (const event of events) {
    if (event.type === "scene.updated") {
      lastUpdateSeq = Math.max(lastUpdateSeq, event.seq);
      if (!createdAt.has(event.payload.specHash)) {
        createdAt.set(event.payload.specHash, event.createdAt);
      }
    } else if (event.type === "scene.rejected") {
      if (lastRejected === null || event.seq >= lastRejected.seq) {
        lastRejected = { seq: event.seq, diagnostics: event.payload.diagnostics };
      }
    }
  }
  return {
    chain,
    headHash: head?.hash ?? null,
    remoteHashes,
    createdAt,
    lastRejected,
    lastUpdateSeq,
  };
}

/**
 * Rebuild the log from the remote main chain plus already-authored local
 * overlay operations, in that order. Overlay operations replay through
 * `applyPatch` + `createChildRevision`, so each replays against its new parent
 * exactly as an inspector edit would — touching only the parameters the user
 * changed, leaving everything the shared chain established intact. A replay
 * that fails validation aborts the whole rebuild rather than landing half a
 * history. Returns null when the walk cannot ground (truncated window) so the
 * caller freezes instead of inventing lineage.
 */
function rebuildRemoteLog(
  view: RemoteView,
  overlay: PatchOp[][],
  sceneId: string,
): { log: RevisionLog; known: Map<string, string> } | null {
  if (view.headHash === null) return null;
  const main = mainChainEntries(view.chain, view.headHash);
  if (main === null) return null;
  const first = main[0];
  if (first === undefined || first.parentHash !== null) return null;
  const genesis = toRevision(
    first,
    null,
    sceneId,
    view.createdAt.get(first.hash) ?? new Date().toISOString(),
  );
  if (genesis === null) return null;
  const log = RevisionLog.begin(genesis);
  const known = new Map([[genesis.specHash, genesis.id]]);
  let previous = genesis;
  for (const entry of main.slice(1)) {
    if (entry.parentHash !== previous.specHash) return null;
    const revision = toRevision(
      entry,
      previous.id,
      sceneId,
      view.createdAt.get(entry.hash) ?? new Date().toISOString(),
    );
    if (revision === null) return null;
    log.append(revision);
    known.set(revision.specHash, revision.id);
    previous = revision;
  }
  for (const ops of overlay) {
    const tip = log.head();
    const patched = applyPatch(tip.spec, { baseRevision: tip.specHash, ops }, tip.specHash);
    if (!patched.ok) return null;
    const child = createChildRevision({
      sceneId,
      parent: tip,
      spec: patched.value,
      author: { kind: "user", label: "width edit" },
    });
    if (!child.ok) return null;
    log.append(child.value);
    known.set(child.value.specHash, child.value.id);
  }
  return { log, known };
}
/** Walk the head pointer back to the revision with the given hash, if reachable. */
function moveHeadToHash(log: RevisionLog, hash: string): boolean {
  let guard = log.history().length + 1;
  while (log.head().specHash !== hash && guard-- > 0) {
    if (log.undo() === null) return false;
  }
  return log.head().specHash === hash;
}

/**
 * Drop overlay operations once the head parks back on shared state. An undo
 * that returns to a shared revision means the user set the pending work
 * aside; replaying it later would resurrect explicitly parked edits. Redo
 * still works locally (the revisions stay in the log object) — only the
 * recorded operations, which drive future replays, are forgotten.
 *
 * Observed consequence: redo displays the parked edit, but the next remote
 * sync rebuilds from the shared chain without it — redo cannot restore
 * operations a sync has shelved. Whether that silent shelving is the intended
 * product contract is undecided (see the ADR addendum); this function pins
 * what is, and the sync test pins it with it.
 */
function pruneOverlayToHead(
  log: RevisionLog,
  remote: Set<string>,
  overlay: { baseHash: string; ops: PatchOp[][] } | null,
): { baseHash: string; ops: PatchOp[][] } | null {
  if (overlay === null) return null;
  return remote.has(log.head().specHash) ? null : overlay;
}

/**
 * The linear main chain ending at the fold head, oldest first. Dead branches
 * (superseded by later order, or stranded by a revert) are display history, not
 * display state: the pane shows what the fold accepts as current, and the full
 * log still holds the rest. Returns null when the walk cannot ground — a
 * truncated window, never a well-formed replay — so the caller freezes instead
 * of inventing lineage.
 */
function mainChainEntries(
  chain: AcceptedSceneRevision[],
  headHash: string,
): AcceptedSceneRevision[] | null {
  const byHash = new Map(chain.map((entry) => [entry.hash, entry] as const));
  const out: AcceptedSceneRevision[] = [];
  const seen = new Set<string>();
  let hash: string | null = headHash;
  let guard = chain.length + 1;
  while (hash !== null && guard-- > 0) {
    if (seen.has(hash)) return null;
    seen.add(hash);
    const entry = byHash.get(hash);
    if (entry === undefined) return null;
    out.unshift(entry);
    hash = entry.parentHash;
  }
  const first = out[0];
  if (first === undefined || first.parentHash !== null) return null;
  return out;
}

function genesisLog(): RevisionLog {
  const genesis = createGenesisRevision({
    sceneId: "local-tower",
    spec: towerSpec(),
    author: { kind: "system", label: "tower fixture" },
  });
  if (!genesis.ok) throw new Error(`tower fixture invalid: ${genesis.error.message}`);
  return RevisionLog.begin(genesis.value);
}

export function useSceneRevisions(options?: SceneRevisionsOptions): SceneController {
  const events = options?.events;
  const sessionId = options?.sessionId;
  const logRef = useRef<RevisionLog | null>(null);
  if (logRef.current === null) {
    logRef.current = genesisLog();
  }

  // Content-hash to revision id, across every materialization and local edit.
  // Monotonic: hashes are content-addressed, so an entry never goes stale, and
  // a revision dropped by a rebuild keeps resolving until it is overwritten.
  // Entries are verified against the live log object before use, so a stale
  // mapping can never point at a revision that is no longer there.
  const knownRef = useRef(new Map<string, string>());
  // Spec hashes the shared chain contains, for overlay derivation.
  const remoteRef = useRef(new Set<string>());
  // User-authored operations the shared log hasn't seen, with the hash they
  // were edited from. Operations replay cleanly onto any tip; whole specs
  // would clobber whatever the shared chain established meanwhile. Cleared by
  // explicit adoption and when undo parks the head back on shared state.
  const overlayRef = useRef<{ baseHash: string; ops: PatchOp[][] } | null>(null);
  // The session these refs belong to. A different session is a different scene:
  // reset everything rather than folding one project's log into another's view.
  const sessionRef = useRef<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<SceneController["notice"]>(null);

  // Seed the maps from the genesis revision, once, alongside the log itself.
  if (logRef.current !== null && knownRef.current.size === 0) {
    const genesis = logRef.current.head();
    knownRef.current.set(genesis.specHash, genesis.id);
  }

  // The generation counter is the entire render trigger: every mutation below
  // bumps it, so no edit can land without the viewport, tree and history
  // re-rendering. The head itself is always read fresh from the log.
  const [, setGeneration] = useState(0);
  const touch = useCallback(() => setGeneration((n) => n + 1), []);
  const [selectedId, setSelectedId] = useState<string | null>("base");
  const [editError, setEditError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ state: "idle" });
  const downloadUrlRef = useRef<string | null>(null);

  // Temporary object URLs are revoked when replaced and when the pane unmounts —
  // a download link that outlives its bytes is a leak with a URL on it.
  useEffect(
    () => () => {
      if (downloadUrlRef.current !== null) URL.revokeObjectURL(downloadUrlRef.current);
    },
    [],
  );

  // ---- Shared-state sync -------------------------------------------------
  // The rules, in one place so no path below can improvise:
  // - Adopt remote entries only by content hash, never twice, never partial.
  // - A remote entry attaches under its resolved parent, or not at all.
  // - Local overlay (user operations the log hasn't seen) is never silently
  //   merged into, rebased onto, or dropped for a remote advance: divergence
  //   surfaces as a conflict notice with an explicit adopt action.
  // - Undo/redo/selection are pointer moves over whatever chain exists; sync
  //   never moves them except to follow an adopted remote head or a revert.
  // - The overlay is a stored operation list, not derived state: replaying
  //   whole specs would clobber whatever the shared chain established
  //   meanwhile, while operations touch only their own parameters.
  useEffect(() => {
    let reset = false;
    if (sessionRef.current !== (sessionId ?? null)) {
      // A different session is a different scene: reset rather than folding one
      // session's events into another's view. Falls through to sync below so a
      // mount that already carries events adopts them on the first pass.
      sessionRef.current = sessionId ?? null;
      logRef.current = genesisLog();
      const genesis = logRef.current.head();
      knownRef.current = new Map([[genesis.specHash, genesis.id]]);
      remoteRef.current = new Set();
      overlayRef.current = null;
      setNotice(null);
      setSelectedId("base");
      reset = true;
    }
    if (events === undefined || events.length === 0) {
      if (reset) touch();
      return;
    }
    let log = logRef.current as RevisionLog;
    const known = knownRef.current;
    const remote = remoteRef.current;
    const view = viewRemoteEvents(events);
    for (const entry of view.chain) remote.add(entry.hash);
    let changed = false;

    const resolveId = (hash: string): string | undefined => {
      const id = known.get(hash);
      if (id === undefined) return undefined;
      // The map outlives log objects across rebuilds: verify before trusting.
      return log.get(id)?.specHash === hash ? id : undefined;
    };

    const noteConflict = (edits: number): void => {
      setNotice({
        kind: "conflict",
        text:
          edits > 0
            ? `The shared scene differs from your ${edits} local edit(s) not in shared history. Your edits are kept — load the shared scene to switch to it.`
            : "The shared history has updates this view cannot follow yet.",
      });
      changed = true;
    };

    const adoptIncremental = (): boolean => {
      for (const entry of view.chain) {
        if (known.has(entry.hash)) continue;
        if (entry.parentHash === null) return false;
        const parentId = resolveId(entry.parentHash);
        if (parentId === undefined || parentId !== log.head().id) return false;
        const revision = toRevision(
          entry,
          parentId,
          sessionId ?? "local-tower",
          view.createdAt.get(entry.hash) ?? new Date().toISOString(),
        );
        if (revision === null) return false;
        log.append(revision);
        known.set(revision.specHash, revision.id);
      }
      return true;
    };

    const fresh = view.chain.filter((entry) => !known.has(entry.hash));
    const pendingOverlay = overlayRef.current;
    if (fresh.length === 0) {
      // Nothing new: maybe a revert moved the fold head behind the display.
      if (
        pendingOverlay === null &&
        view.headHash !== null &&
        view.headHash !== log.head().specHash
      ) {
        if (moveHeadToHash(log, view.headHash)) changed = true;
        else {
          noteConflict(0);
        }
      }
    } else if (pendingOverlay === null) {
      if (!adoptIncremental()) {
        // Non-linear advance (a second genesis, a branch): rebuild rather than
        // force entries under the wrong parent. No overlay exists to lose.
        if (adoptFromChain()) changed = true;
        else noteConflict(0);
      } else {
        changed = true;
      }
    } else if (remote.has(pendingOverlay.baseHash)) {
      // Compatible overlay: replay user operations onto the fresh remote tip.
      // Operations touch only their own parameters, so the shared chain's
      // other changes survive — unlike replaying whole specs, which would
      // clobber them with stale values.
      const rebuilt = rebuildRemoteLog(view, pendingOverlay.ops, sessionId ?? "local-tower");
      if (rebuilt === null) {
        noteConflict(pendingOverlay.ops.length);
      } else {
        logRef.current = rebuilt.log;
        knownRef.current = rebuilt.known;
        log = rebuilt.log;
        changed = true;
      }
    } else {
      noteConflict(pendingOverlay.ops.length);
    }

    function adoptFromChain(): boolean {
      if (view.headHash === null) return false;
      const rebuilt = rebuildRemoteLog(view, [], sessionId ?? "local-tower");
      if (rebuilt === null) return false;
      logRef.current = rebuilt.log;
      knownRef.current = rebuilt.known;
      log = rebuilt.log;
      return true;
    }

    // Rejections surface unless a conflict already speaks louder. A rejection
    // older than the newest update is stale news, not a banner.
    if (view.lastRejected !== null && view.lastRejected.seq > view.lastUpdateSeq) {
      setNotice({ kind: "rejected", text: view.lastRejected.diagnostics });
    }
    if (changed) touch();
    // `events` is the only reactive *input*: refs are mutation targets, and
    // `touch` is a stable useCallback — listed for the linter, never a trigger.
    // Session switches are handled above by value.
  }, [events, sessionId, touch]);

  /** Rebuild the log purely from the shared chain, dropping local overlay. */
  const adoptSharedScene = useCallback(() => {
    if (events === undefined || events.length === 0) return;
    const view = viewRemoteEvents(events);
    if (view.headHash === null) return;
    const rebuilt = rebuildRemoteLog(view, [], sessionId ?? "local-tower");
    if (rebuilt === null) return;
    logRef.current = rebuilt.log;
    knownRef.current = rebuilt.known;
    overlayRef.current = null;
    setNotice(null);
    setExportStatus({ state: "idle" });
    touch();
  }, [events, sessionId, touch]);

  const head = (logRef.current as RevisionLog).head();
  // Recomputed every render deliberately: the log is a ref, so no reactive dep
  // can name it, and the chain is a handful of revisions — memoizing would trade
  // a trivial array walk for a lint suppression.
  const history = (logRef.current as RevisionLog).history();

  const buildResult = useMemo(() => buildScene(head.spec), [head]);
  const built = buildResult.ok ? buildResult.value : null;
  const buildError = buildResult.ok ? null : buildResult.error.message;

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const setWidth = useCallback(
    (nodeId: string, width: number) => {
      const log = logRef.current as RevisionLog;
      if (!Number.isFinite(width)) {
        setEditError("Width must be a number.");
        return;
      }
      if (width < MIN_DIMENSION_M || width > MAX_DIMENSION_M) {
        setEditError(`Width must be between ${MIN_DIMENSION_M} and ${MAX_DIMENSION_M} m.`);
        return;
      }
      const current = log.head();
      // Dirty check: focusing the field and tabbing away, or Enter followed by
      // blur, must not append revisions that changed nothing.
      const node = current.spec.nodes.find((candidate) => candidate.id === nodeId);
      if (node?.kind === "procedural" && node.op === "box" && node.params.width === width) {
        setEditError(null);
        return;
      }
      const ops: PatchOp[] = [{ op: "set_param", nodeId, key: "width", value: width }];
      const patched = applyPatch(
        current.spec,
        {
          baseRevision: current.specHash,
          ops,
        },
        current.specHash,
      );
      if (!patched.ok) {
        setEditError(patchErrorCopy(patched.error.code, patched.error.message));
        return;
      }
      const child = createChildRevision({
        sceneId: current.sceneId,
        parent: current,
        spec: patched.value,
        author: { kind: "user", label: "width edit" },
      });
      if (!child.ok) {
        setEditError(child.error.message);
        return;
      }
      log.append(child.value);
      knownRef.current.set(child.value.specHash, child.value.id);
      // Record the operations, not the resulting spec: replaying ops onto a
      // newer tip touches only their own parameters, while replaying whole
      // specs would clobber whatever the shared chain established meanwhile.
      const overlay = overlayRef.current;
      if (overlay === null) {
        overlayRef.current = { baseHash: current.specHash, ops: [ops] };
      } else {
        overlay.ops.push(ops);
      }
      setEditError(null);
      setNotice(null);
      setExportStatus({ state: "idle" });
      touch();
    },
    [touch],
  );

  const undo = useCallback(() => {
    const log = logRef.current as RevisionLog;
    const parent = log.undo();
    if (parent === null) return;
    overlayRef.current = pruneOverlayToHead(log, remoteRef.current, overlayRef.current);
    setEditError(null);
    setNotice(null);
    setExportStatus({ state: "idle" });
    touch();
  }, [touch]);

  const redo = useCallback(() => {
    const log = logRef.current as RevisionLog;
    const next = log.redo();
    if (next === null) return;
    overlayRef.current = pruneOverlayToHead(log, remoteRef.current, overlayRef.current);
    setEditError(null);
    setNotice(null);
    setExportStatus({ state: "idle" });
    touch();
  }, [touch]);

  const exportAndValidate = useCallback(async () => {
    const log = logRef.current as RevisionLog;
    const started = log.head();
    const result = buildScene(started.spec);
    if (!result.ok) {
      setExportStatus({ state: "error", message: `Build failed: ${result.error.message}` });
      return;
    }
    setExportStatus({ state: "exporting" });
    const group = builtSceneToGroup(result.value);
    try {
      const exported = await exportGlb(group);
      if (!exported.ok) {
        setExportStatus({ state: "error", message: `Export failed: ${exported.error.message}` });
        return;
      }
      const reimported = await reimportGlb(exported.value);
      if (!reimported.ok) {
        setExportStatus({
          state: "error",
          message: `Re-import failed: ${reimported.error.message}`,
        });
        return;
      }
      // The adapter bakes world transforms into vertices, so the built-scene
      // bounds are the expectation — no second scene graph involved.
      if (!boundsMatch(reimported.value.bounds, result.value.bounds)) {
        setExportStatus({
          state: "error",
          message: "Re-imported bounds differ from the built scene beyond tolerance.",
        });
        return;
      }
      if (downloadUrlRef.current !== null) URL.revokeObjectURL(downloadUrlRef.current);
      const blob = new Blob([exported.value as BlobPart], { type: "model/gltf-binary" });
      const downloadUrl = URL.createObjectURL(blob);
      downloadUrlRef.current = downloadUrl;
      setExportStatus({
        state: "ready",
        forRevision: started.specHash.slice(0, 12),
        current: log.head().id === started.id,
        byteLength: exported.value.length,
        meshCount: reimported.value.meshCount,
        downloadUrl,
      });
    } finally {
      disposeGroup(group);
    }
  }, []);

  return {
    head,
    history,
    canUndo: head.parentId !== null,
    canRedo: (logRef.current as RevisionLog).canRedo(),
    selectedId,
    built,
    buildError,
    editError,
    notice,
    exportStatus,
    select,
    setWidth,
    undo,
    redo,
    adoptSharedScene,
    exportAndValidate,
  };
}

function patchErrorCopy(code: string, message: string): string {
  switch (code) {
    case "stale_base":
      return `Someone else edited first (${message}). Reload and try again.`;
    case "unknown_param":
      return `That parameter cannot be edited here (${message}).`;
    default:
      return message;
  }
}
