"use client";

/**
 * Revision history with undo/redo.
 *
 * Every entry is a real immutable revision — short hash, author label, time —
 * and the current head is marked, not merely last. Undo moves the head pointer
 * to the parent; the undone revision stays in the log (which is what makes redo
 * possible) but leaves the visible list, since the list shows the chain behind
 * the head.
 */

import type { SceneRevision } from "@vibe-vr/scene-spec/revisions";

export function History({
  history,
  headId,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  history: SceneRevision[];
  headId: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className="rounded-chip border border-edge px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          className="rounded-chip border border-edge px-3 py-1 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Redo
        </button>
      </div>
      <ol aria-label="Scene revisions" className="space-y-1 text-xs">
        {history.map((revision, index) => {
          const current = revision.id === headId;
          return (
            <li
              key={revision.id}
              aria-current={current ? true : undefined}
              className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 ${
                current ? "bg-hover font-medium text-ink" : "text-muted"
              }`}
            >
              <span>
                r{index} · <span className="font-mono">{revision.specHash.slice(0, 8)}</span> ·{" "}
                {revision.author.label}
              </span>
              {current && <span className="text-[11px]">current</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
