"use client";

/**
 * The parameter inspector for the selected node.
 *
 * This slice edits one thing — the width of a box — through the same patch
 * contract the future agent tools will speak. The input is local draft state
 * committed explicitly (Enter or blur), so half-typed numbers never reach the
 * revision log; validation failures surface next to the field and create no
 * revision. Non-box and group nodes get a truthful "nothing editable here yet"
 * rather than a disabled control pretending otherwise.
 */

import type { SceneNode } from "@vibe-vr/scene-spec/schema";
import { useEffect, useState } from "react";

export function Inspector({
  node,
  editError,
  onSetWidth,
}: {
  node: SceneNode | null;
  editError: string | null;
  onSetWidth: (nodeId: string, width: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  // A new selection — or a newly committed head — replaces the draft. The node
  // object is stable across renders until the revision changes, so typing is
  // never interrupted and committed values sync back after an edit.
  useEffect(() => {
    setDraft(currentWidth(node));
    setLocalError(null);
  }, [node]);

  if (node === null) {
    return <p className="text-sm text-muted">Select an object to inspect it.</p>;
  }

  const editable = node.kind === "procedural" && node.op === "box";
  const commit = () => {
    if (!editable) return;
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value)) {
      setLocalError("Enter a finite number in meters.");
      return;
    }
    setLocalError(null);
    onSetWidth(node.id, value);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-ink text-sm">{node.name}</h3>
        <p className="font-mono text-[11px] text-muted">
          {node.kind === "group" ? "group" : node.op} · {node.id}
        </p>
      </div>

      {node.kind === "group" ? (
        <p className="text-sm text-muted">
          Groups carry children, not parameters — nothing to edit here yet.
        </p>
      ) : node.op !== "box" ? (
        <p className="text-sm text-muted">Parameter editing covers boxes in this slice.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
          className="space-y-1.5"
        >
          <label htmlFor="inspector-width" className="block text-ink-2 text-xs">
            Width (m)
          </label>
          <input
            id="inspector-width"
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            spellCheck={false}
            className="w-full rounded-chip border border-edge bg-field px-3 py-1 font-mono text-sm text-ink outline-none focus-visible:border-line-strong"
          />
          {(localError ?? editError) && (
            <p role="alert" className="text-danger text-xs">
              {localError ?? editError}
            </p>
          )}
        </form>
      )}

      <dl className="space-y-1 text-xs text-muted">
        <div className="flex justify-between gap-2">
          <dt>Position</dt>
          <dd className="font-mono">{formatVec(node.transform.position)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Scale</dt>
          <dd className="font-mono">{formatVec(node.transform.scale)}</dd>
        </div>
      </dl>
    </div>
  );
}

function currentWidth(node: SceneNode | null): string {
  if (node?.kind === "procedural" && node.op === "box") return String(node.params.width);
  return "";
}

function formatVec(vec: readonly [number, number, number]): string {
  return vec.map((n) => n.toFixed(2)).join(", ");
}
