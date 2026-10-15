import { hashSceneSpec } from "@vibe-vr/scene-spec/revisions";
import { towerSpec } from "@vibe-vr/scene-spec/tower";
import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelPane } from "./model-pane.tsx";
import type { RendererHandle } from "./scene-view.tsx";
import { installViewportTestShims } from "./test-shims.ts";

installViewportTestShims();

const ORIGINAL_HASH = "b3534b9a9a9f507cb5c610dac20bdc27d0eb3db5f302eb4776b86c64b48f65b8";

let nextSeq = 100;

function sceneEvent(
  seq: number,
  event: { type: "scene.updated"; payload: unknown } | { type: "scene.rejected"; payload: unknown },
): StoredEvent {
  nextSeq = Math.max(nextSeq, seq + 1);
  return {
    type: event.type,
    sessionId: "session-1",
    turnId: "turn-1",
    seq,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: event.payload,
  } as StoredEvent;
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

describe("ModelPane", () => {
  it("mounts the viewport canvas, tree, inspector and history", () => {
    render(<ModelPane active={true} />);
    expect(
      screen.getByLabelText("3D viewport. Use the scene tree to select objects."),
    ).toBeInTheDocument();
  });

  it("says the 3D preview is unavailable when WebGL cannot start", () => {
    // jsdom has no WebGL context, so the default renderer factory fails here —
    // the pane must say so rather than mount a dead canvas.
    render(<ModelPane active={true} />);
    expect(screen.getByText(/3D preview is unavailable here/)).toBeInTheDocument();
    // The rest of the face still works.
    expect(screen.getByRole("button", { name: "Select Base" })).toBeInTheDocument();
  });

  it("selects a node from the tree and shows it in the inspector", () => {
    render(<ModelPane active={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Middle" }));
    expect(screen.getByLabelText("Width (m)")).toHaveValue("1.4");
  });

  it("edits the width through the inspector and records a revision", () => {
    render(<ModelPane active={true} />);
    const input = screen.getByLabelText("Width (m)");
    expect(input).toHaveValue("2");
    fireEvent.change(input, { target: { value: "2.4" } });
    fireEvent.blur(input);
    expect(screen.getByRole("list", { name: "Scene revisions" }).children).toHaveLength(2);
    expect(screen.queryByText(ORIGINAL_HASH.slice(0, 12))).not.toBeInTheDocument();
  });

  it("undo restores the original hash", () => {
    render(<ModelPane active={true} />);
    const input = screen.getByLabelText("Width (m)");
    fireEvent.change(input, { target: { value: "2.4" } });
    fireEvent.blur(input);
    expect(screen.getByRole("list", { name: "Scene revisions" }).children).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText(ORIGINAL_HASH.slice(0, 12))).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Scene revisions" }).children).toHaveLength(1);
  });

  it("surfaces invalid input without creating a revision", () => {
    render(<ModelPane active={true} />);
    const input = screen.getByLabelText("Width (m)");
    fireEvent.change(input, { target: { value: "banana" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Scene revisions" }).children).toHaveLength(1);
  });

  it("shows shared revisions and rejection notices from session events", () => {
    const genesisHash = hashSceneSpec(towerSpec());
    render(
      <ModelPane
        active={true}
        sessionId="session-1"
        events={[
          sceneEvent(1, {
            type: "scene.updated",
            payload: { spec: towerSpec(), parentHash: null, specHash: genesisHash },
          }),
          sceneEvent(2, {
            type: "scene.rejected",
            payload: { code: "stale_base", diagnostics: "proposal targets an older revision" },
          }),
        ]}
      />,
    );

    // The shared revision is displayed; the rejection is a status line, and the
    // transcript remains the only place tool results appear.
    expect(screen.getByRole("list", { name: "Scene revisions" }).children).toHaveLength(1);
    expect(screen.getByText(/older revision/)).toBeInTheDocument();
  });

  it("offers adoption when local edits diverge from shared state", () => {
    const divergent = towerWithoutMid();
    const divergentHash = hashSceneSpec(divergent);
    const { rerender } = render(<ModelPane active={true} sessionId="session-1" events={[]} />);

    // A local edit first, then the divergent shared genesis arrives.
    const input = screen.getByLabelText("Width (m)");
    fireEvent.change(input, { target: { value: "2.4" } });
    fireEvent.blur(input);
    rerender(
      <ModelPane
        active={true}
        sessionId="session-1"
        events={[
          sceneEvent(1, {
            type: "scene.updated",
            payload: { spec: divergent, parentHash: null, specHash: divergentHash },
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Load shared scene" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load shared scene" }));
    expect(screen.queryByRole("button", { name: "Load shared scene" })).not.toBeInTheDocument();
  });
});

describe("SceneView renderer lifecycle", () => {
  it("disposes the injected renderer on unmount", async () => {
    const { SceneView } = await import("./scene-view.tsx");
    const { buildScene } = await import("@vibe-vr/procedural/build");
    const { towerSpec } = await import("@vibe-vr/scene-spec/tower");
    const built = buildScene(towerSpec());
    if (!built.ok) throw new Error("fixture failed to build");

    const disposed: string[] = [];
    const renders: number[] = [];
    const fake = (): RendererHandle => ({
      render: () => {
        renders.push(1);
      },
      setSize: () => {},
      dispose: () => {
        disposed.push("renderer");
      },
    });

    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    const raf = (callback: FrameRequestCallback): number => {
      const id = nextId++;
      rafCallbacks.set(id, callback);
      return id;
    };
    const caf = (id: number): void => {
      rafCallbacks.delete(id);
    };
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = raf as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = caf;
    try {
      const { unmount } = render(
        <SceneView
          built={built.value}
          selectedId={null}
          onSelect={() => {}}
          active={true}
          createRenderer={fake}
        />,
      );
      // Drive one frame manually.
      const [, first] = [...rafCallbacks.entries()][0] ?? [];
      expect(first).toBeDefined();
      unmount();
      expect(disposed).toEqual(["renderer"]);
      // After unmount no frame remains scheduled: nothing renders for nobody.
      expect(rafCallbacks.size).toBe(0);
      expect(renders.length).toBeLessThanOrEqual(1);
    } finally {
      globalThis.requestAnimationFrame = previousRaf;
      globalThis.cancelAnimationFrame = previousCaf;
    }
  });
});
