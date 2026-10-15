"use client";

/**
 * The scene hierarchy: groups nest, leaves select.
 *
 * Buttons, not divs with handlers — selection is the primary keyboard path to
 * the 3D scene, and a treeitem that cannot receive focus is decoration. The
 * selected node is marked with `aria-current`, the same signal the inspector
 * reads to decide what it edits.
 */

import type { SceneNode, SceneSpec } from "@vibe-vr/scene-spec/schema";

export function SceneTree({
  spec,
  selectedId,
  onSelect,
}: {
  spec: SceneSpec;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const byId = new Map<string, SceneNode>(spec.nodes.map((node) => [node.id, node]));
  const root = byId.get(spec.root);
  if (root === undefined) return <p role="status">Scene has no root.</p>;
  return (
    <ul aria-label="Scene hierarchy" className="space-y-0.5 text-sm">
      <TreeNode node={root} byId={byId} depth={0} selectedId={selectedId} onSelect={onSelect} />
    </ul>
  );
}

function TreeNode({
  node,
  byId,
  depth,
  selectedId,
  onSelect,
}: {
  node: SceneNode;
  byId: Map<string, SceneNode>;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = node.id === selectedId;
  const detail = node.kind === "group" ? `${node.children.length} children` : node.op;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? true : undefined}
        aria-label={`Select ${node.name}`}
        onClick={() => onSelect(node.id)}
        className={`w-full rounded px-2 py-1 text-left transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
          selected ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
        }`}
        style={{ paddingLeft: `${depth * 1 + 0.5}rem` }}
      >
        <span className="font-mono text-[11px] text-muted">
          {node.kind === "group" ? "▾" : "▪"}
        </span>{" "}
        {node.name} <span className="text-[11px] text-muted">· {detail}</span>
      </button>
      {node.kind === "group" && (
        <ul className="space-y-0.5">
          {node.children.map((childId) => {
            const child = byId.get(childId);
            if (child === undefined) return null;
            return (
              <TreeNode
                key={childId}
                node={child}
                byId={byId}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}
