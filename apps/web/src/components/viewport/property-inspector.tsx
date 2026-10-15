"use client";

/**
 * Property Inspector & Scene Hierarchy Tree.
 *
 * Displays:
 * 1. Scene node hierarchy tree with group/mesh icons, nested indent, and delete action.
 * 2. Live property editing for the selected node:
 *    - Transforms: Position (X, Y, Z), Rotation (X, Y, Z in deg), Scale (X, Y, Z)
 *    - Geometry dimensions for 6 primitives (box, cylinder, sphere, cone, torus, capsule)
 *    - PBR Material properties (hex/color picker, roughness, metalness, opacity)
 * 3. History toolbar: Undo/Redo buttons with Cmd+Z / Cmd+Shift+Z shortcuts.
 * 4. Export JSON button to download the live scene state.
 */

import { useEffect } from "react";
import {
  type GeometrySpec,
  type MaterialSpec,
  type SceneNode,
  useSceneStore,
} from "../../store/scene-store.ts";

export type PropertyInspectorProps = {
  className?: string;
};

export function PropertyInspector({ className = "" }: PropertyInspectorProps) {
  const {
    nodes,
    revision,
    selectedNodeId,
    undoStack,
    redoStack,
    setSelectedNodeId,
    updateNodeTransform,
    updateNodeGeometry,
    updateNodeMaterial,
    deleteNode,
    undo,
    redo,
  } = useSceneStore();

  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;

  // Global Keyboard shortcuts for Undo (Cmd+Z / Ctrl+Z) and Redo (Cmd+Shift+Z / Ctrl+Y)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (!modifier) return;

      const activeTag = document.activeElement?.tagName.toLowerCase();
      const isInput = activeTag === "input" || activeTag === "textarea";

      if (e.key === "z" && !e.shiftKey) {
        if (!isInput) {
          e.preventDefault();
          undo();
        }
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        if (!isInput) {
          e.preventDefault();
          redo();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  // Download scene as JSON
  const handleExport = () => {
    const data = JSON.stringify(
      {
        revision,
        nodes,
      },
      null,
      2,
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vibe-vr-scene-rev${revision}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Group nodes by parentId
  const rootNodes: SceneNode[] = [];
  const childrenByParent = new Map<string, SceneNode[]>();

  for (const node of Object.values(nodes)) {
    if (!node.parentId || !nodes[node.parentId]) {
      rootNodes.push(node);
    } else {
      const list = childrenByParent.get(node.parentId) ?? [];
      list.push(node);
      childrenByParent.set(node.parentId, list);
    }
  }

  const renderTreeNode = (node: SceneNode, depth = 0) => {
    const children = childrenByParent.get(node.nodeId) ?? [];
    const isSelected = selectedNodeId === node.nodeId;

    return (
      <div key={node.nodeId} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setSelectedNodeId(node.nodeId)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSelectedNodeId(node.nodeId);
            }
          }}
          className={`flex items-center justify-between rounded px-2 py-1 text-xs cursor-pointer select-none transition-colors ${
            isSelected
              ? "bg-indigo-600/30 text-indigo-200 border border-indigo-500/40"
              : "text-neutral-300 hover:bg-neutral-800/60"
          }`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          <div className="flex items-center gap-1.5 truncate">
            <span className="text-[11px] text-neutral-500">
              {node.nodeType === "group" ? "📁" : "🧊"}
            </span>
            <span className="truncate">{node.name || node.nodeId}</span>
          </div>

          <button
            type="button"
            aria-label={`Delete ${node.name || node.nodeId}`}
            onClick={(e) => {
              e.stopPropagation();
              deleteNode(node.nodeId);
            }}
            className="text-neutral-500 hover:text-red-400 p-0.5 opacity-60 hover:opacity-100 transition-opacity"
          >
            ×
          </button>
        </div>

        {children.map((child) => renderTreeNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div
      role="region"
      aria-label="Scene Property Inspector"
      className={`flex flex-col rounded-xl border border-neutral-800 bg-neutral-950/90 text-neutral-200 shadow-xl backdrop-blur-md overflow-hidden ${className}`}
    >
      {/* Top Action Bar */}
      <div className="flex items-center justify-between border-b border-neutral-800 p-3 bg-neutral-900/40">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-neutral-400">Scene</span>
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            Rev #{revision}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.length === 0}
            title="Undo (Ctrl+Z / Cmd+Z)"
            aria-label="Undo"
            className="rounded px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ↺ Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.length === 0}
            title="Redo (Ctrl+Y / Cmd+Shift+Z)"
            aria-label="Redo"
            className="rounded px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ↻ Redo
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="ml-2 rounded border border-neutral-700 bg-neutral-800/80 px-2.5 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-700 transition-colors shadow-sm"
          >
            Export JSON
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-neutral-800 overflow-y-auto">
        {/* Node Hierarchy Tree */}
        <div className="w-full md:w-56 p-3 space-y-2 overflow-y-auto max-h-60 md:max-h-none">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            Hierarchy ({Object.keys(nodes).length})
          </div>
          <div className="space-y-0.5">
            {rootNodes.length > 0 ? (
              rootNodes.map((n) => renderTreeNode(n, 0))
            ) : (
              <p className="text-xs text-neutral-500 italic py-2">
                No nodes in scene.
              </p>
            )}
          </div>
        </div>

        {/* Selected Node Inspector */}
        <div className="flex-1 p-4 space-y-4 overflow-y-auto">
          {selectedNode ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
                <div>
                  <h4 className="font-semibold text-sm text-neutral-100">
                    {selectedNode.name || selectedNode.nodeId}
                  </h4>
                  <p className="font-mono text-[11px] text-neutral-500">
                    ID: {selectedNode.nodeId} · Type: {selectedNode.nodeType}
                  </p>
                </div>
              </div>

              {/* Transform Inputs */}
              <div className="space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Transform
                </span>

                {/* Position */}
                <div className="grid grid-cols-4 items-center gap-2 text-xs">
                  <span className="text-neutral-400">Position (m)</span>
                  {(["X", "Y", "Z"] as const).map((axis, idx) => (
                    <div key={`pos-${axis}`} className="flex items-center gap-1">
                      <span className="text-[10px] text-neutral-500">{axis}</span>
                      <input
                        type="number"
                        step="0.05"
                        value={selectedNode.transform.position[idx]}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value) || 0;
                          const nextPos = [...selectedNode.transform.position] as [
                            number,
                            number,
                            number,
                          ];
                          nextPos[idx] = val;
                          updateNodeTransform(selectedNode.nodeId, {
                            position: nextPos,
                          });
                        }}
                        className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-100 focus:outline-none focus:border-indigo-400"
                      />
                    </div>
                  ))}
                </div>

                {/* Rotation */}
                <div className="grid grid-cols-4 items-center gap-2 text-xs">
                  <span className="text-neutral-400">Rotation (°)</span>
                  {(["X", "Y", "Z"] as const).map((axis, idx) => (
                    <div key={`rot-${axis}`} className="flex items-center gap-1">
                      <span className="text-[10px] text-neutral-500">{axis}</span>
                      <input
                        type="number"
                        step="5"
                        value={selectedNode.transform.rotationDeg[idx]}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value) || 0;
                          const nextRot = [
                            ...selectedNode.transform.rotationDeg,
                          ] as [number, number, number];
                          nextRot[idx] = val;
                          updateNodeTransform(selectedNode.nodeId, {
                            rotationDeg: nextRot,
                          });
                        }}
                        className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-100 focus:outline-none focus:border-indigo-400"
                      />
                    </div>
                  ))}
                </div>

                {/* Scale */}
                <div className="grid grid-cols-4 items-center gap-2 text-xs">
                  <span className="text-neutral-400">Scale</span>
                  {(["X", "Y", "Z"] as const).map((axis, idx) => (
                    <div key={`scale-${axis}`} className="flex items-center gap-1">
                      <span className="text-[10px] text-neutral-500">{axis}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={selectedNode.transform.scale[idx]}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value) || 1;
                          const nextScale = [...selectedNode.transform.scale] as [
                            number,
                            number,
                            number,
                          ];
                          nextScale[idx] = val;
                          updateNodeTransform(selectedNode.nodeId, {
                            scale: nextScale,
                          });
                        }}
                        className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-100 focus:outline-none focus:border-indigo-400"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Geometry Dimensions */}
              {selectedNode.geometry && (() => {
                const geom = selectedNode.geometry;
                return (
                  <div className="space-y-2 pt-2 border-t border-neutral-800">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                      Geometry ({geom.kind})
                    </span>

                    {geom.kind === "box" && (() => {
                      const box = geom;
                      return (
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Width (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={box.width}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...box,
                                  width: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Height (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={box.height}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...box,
                                  height: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Depth (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={box.depth}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...box,
                                  depth: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {geom.kind === "cylinder" && (() => {
                      const cyl = geom;
                      return (
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Radius Top (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0"
                              value={cyl.radiusTop}
                              onChange={(e) => {
                                const val = Math.max(0, Number.parseFloat(e.target.value) || 0);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cyl,
                                  radiusTop: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Radius Bottom (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0"
                              value={cyl.radiusBottom}
                              onChange={(e) => {
                                const val = Math.max(0, Number.parseFloat(e.target.value) || 0);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cyl,
                                  radiusBottom: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Height (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={cyl.height}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cyl,
                                  height: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {geom.kind === "sphere" && (() => {
                      const sph = geom;
                      return (
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Radius (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={sph.radius}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...sph,
                                  radius: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {geom.kind === "cone" && (() => {
                      const cone = geom;
                      return (
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Radius (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={cone.radius}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cone,
                                  radius: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Height (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={cone.height}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cone,
                                  height: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {geom.kind === "torus" && (() => {
                      const tor = geom;
                      return (
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Radius (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={tor.radius}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...tor,
                                  radius: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Tube (m)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min="0.005"
                              value={tor.tube}
                              onChange={(e) => {
                                const val = Math.max(0.005, Number.parseFloat(e.target.value) || 0.05);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...tor,
                                  tube: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                        </div>
                      );
                    })()}

                    {geom.kind === "capsule" && (() => {
                      const cap = geom;
                      return (
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Radius (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={cap.radius}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cap,
                                  radius: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-neutral-400 block mb-1">
                              Length (m)
                            </label>
                            <input
                              type="number"
                              step="0.05"
                              min="0.01"
                              value={cap.length}
                              onChange={(e) => {
                                const val = Math.max(0.01, Number.parseFloat(e.target.value) || 0.1);
                                updateNodeGeometry(selectedNode.nodeId, {
                                  ...cap,
                                  length: val,
                                });
                              }}
                              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* Material Properties */}
              {selectedNode.material && (
                <div className="space-y-3 pt-2 border-t border-neutral-800">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                    PBR Material
                  </span>

                  {/* Color */}
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label="Color Picker"
                      value={selectedNode.material.color ?? "#94a3b8"}
                      onChange={(e) =>
                        updateNodeMaterial(selectedNode.nodeId, {
                          color: e.target.value,
                        })
                      }
                      className="h-7 w-7 rounded cursor-pointer border border-neutral-700 bg-transparent p-0"
                    />
                    <input
                      type="text"
                      aria-label="Color Hex"
                      value={selectedNode.material.color ?? "#94a3b8"}
                      onChange={(e) =>
                        updateNodeMaterial(selectedNode.nodeId, {
                          color: e.target.value,
                        })
                      }
                      className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs font-mono text-neutral-100"
                    />
                  </div>

                  {/* Roughness */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-neutral-400">
                      <span>Roughness</span>
                      <span>
                        {(selectedNode.material.roughness ?? 0.5).toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Roughness"
                      min="0"
                      max="1"
                      step="0.01"
                      value={selectedNode.material.roughness ?? 0.5}
                      onChange={(e) =>
                        updateNodeMaterial(selectedNode.nodeId, {
                          roughness: Number.parseFloat(e.target.value),
                        })
                      }
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  {/* Metalness */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-neutral-400">
                      <span>Metalness</span>
                      <span>
                        {(selectedNode.material.metalness ?? 0.0).toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Metalness"
                      min="0"
                      max="1"
                      step="0.01"
                      value={selectedNode.material.metalness ?? 0.0}
                      onChange={(e) =>
                        updateNodeMaterial(selectedNode.nodeId, {
                          metalness: Number.parseFloat(e.target.value),
                        })
                      }
                      className="w-full accent-indigo-500"
                    />
                  </div>

                  {/* Opacity */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-neutral-400">
                      <span>Opacity</span>
                      <span>
                        {(selectedNode.material.opacity ?? 1.0).toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Opacity"
                      min="0.05"
                      max="1"
                      step="0.05"
                      value={selectedNode.material.opacity ?? 1.0}
                      onChange={(e) =>
                        updateNodeMaterial(selectedNode.nodeId, {
                          opacity: Number.parseFloat(e.target.value),
                        })
                      }
                      className="w-full accent-indigo-500"
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-neutral-500">
              Select an object from the tree or click on the 3D canvas to inspect and edit properties.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
