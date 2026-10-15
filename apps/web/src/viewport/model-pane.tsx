"use client";

/**
 * The 3D Model workbench face: viewport, scene tree, inspector, history and export.
 *
 * One `useSceneRevisions` controller feeds every pane, so the tree, the canvas
 * highlight, the inspector and the history cannot disagree — they all read the
 * same head revision. The layout is a canvas with a fixed side panel rather than
 * a resizable split: this face has one job and a splitter would be chrome.
 */

import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { History } from "./history.tsx";
import { Inspector } from "./inspector.tsx";
import { SceneTree } from "./scene-tree.tsx";
import { SceneView } from "./scene-view.tsx";
import { useSceneRevisions } from "./use-scene-revisions.ts";

export function ModelPane({
  active,
  events,
  sessionId,
}: {
  active: boolean;
  events?: readonly StoredEvent[];
  sessionId?: string;
}) {
  const controller = useSceneRevisions(
    events === undefined && sessionId === undefined
      ? undefined
      : {
          ...(events === undefined ? {} : { events }),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
  );
  const selected =
    controller.head.spec.nodes.find((node) => node.id === controller.selectedId) ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SceneView
        built={controller.built}
        selectedId={controller.selectedId}
        onSelect={controller.select}
        active={active}
      />
      <aside
        aria-label="Scene panel"
        className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto border-edge border-l bg-panel p-4"
      >
        {controller.notice !== null && (
          <div
            role="status"
            className="space-y-2 rounded-chip border border-edge bg-field px-3 py-2 text-xs text-ink-2"
          >
            <p>{controller.notice.text}</p>
            {controller.notice.kind === "conflict" && (
              <button
                type="button"
                onClick={() => controller.adoptSharedScene()}
                className="rounded-chip border border-edge px-3 py-1 text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                Load shared scene
              </button>
            )}
          </div>
        )}
        <section aria-label="Scene hierarchy">
          <h2 className="mb-2 font-medium text-ink text-xs uppercase tracking-wide">Scene</h2>
          <SceneTree
            spec={controller.head.spec}
            selectedId={controller.selectedId}
            onSelect={controller.select}
          />
        </section>

        <section aria-label="Inspector">
          <h2 className="mb-2 font-medium text-ink text-xs uppercase tracking-wide">Inspector</h2>
          <Inspector
            node={selected}
            editError={controller.editError}
            onSetWidth={controller.setWidth}
          />
        </section>

        <section aria-label="Revisions">
          <h2 className="mb-2 font-medium text-ink text-xs uppercase tracking-wide">History</h2>
          <History
            history={controller.history}
            headId={controller.head.id}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            onUndo={controller.undo}
            onRedo={controller.redo}
          />
          <p className="mt-1 font-mono text-[11px] text-muted">
            {controller.head.specHash.slice(0, 12)}
          </p>
        </section>

        <section aria-label="Export">
          <h2 className="mb-2 font-medium text-ink text-xs uppercase tracking-wide">Export</h2>
          <ExportControls controller={controller} />
        </section>

        {controller.buildError !== null && (
          <p role="alert" className="text-danger text-xs">
            Build failed: {controller.buildError}
          </p>
        )}
      </aside>
    </div>
  );
}

function ExportControls({ controller }: { controller: ReturnType<typeof useSceneRevisions> }) {
  const status = controller.exportStatus;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void controller.exportAndValidate()}
        disabled={status.state === "exporting" || controller.built === null}
        className="rounded-chip border border-edge px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {status.state === "exporting" ? "Exporting…" : "Export GLB and validate"}
      </button>
      {status.state === "ready" && (
        <div className="space-y-1 text-xs text-ink-2">
          <p role="status">
            Validated: {status.meshCount} meshes, {(status.byteLength / 1024).toFixed(1)} KB
            {status.current ? "" : " (a newer edit has landed since)"}
          </p>
          <a
            href={status.downloadUrl}
            download="tower.glb"
            className="inline-block rounded-chip border border-edge px-3 py-1 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          >
            Download tower.glb
          </a>
        </div>
      )}
      {status.state === "error" && (
        <p role="alert" className="text-danger text-xs">
          {status.message}
        </p>
      )}
    </div>
  );
}
