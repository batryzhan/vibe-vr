import { buildScene } from "@vibe-vr/procedural/build";
import { builtSceneToGroup, disposeGroup } from "@vibe-vr/procedural/three-adapter";
import { InMemorySandboxManager } from "@vibe-vr/sandbox/testing/in-memory-sandbox-manager";
import { hashSceneSpec } from "@vibe-vr/scene-spec/revisions";
import { readSceneHead } from "@vibe-vr/scene-spec/scene-events";
import type { SceneSpec } from "@vibe-vr/scene-spec/schema";
import type { PendingEvent, StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { NapAgentService } from "../agent-service.ts";
import { ScriptedLLMProvider } from "../testing/scripted-llm-provider.ts";

const CHAIR_ID = "11111111-1111-4111-8111-111111111111";
const CHAIR_NODES = [
  "chair",
  "seat",
  "backrest",
  "front-left",
  "front-right",
  "back-left",
  "back-right",
];

function chairBox(
  id: string,
  name: string,
  position: [number, number, number],
  size: [number, number, number],
): SceneSpec["nodes"][number] {
  return {
    id,
    name,
    kind: "procedural",
    op: "box",
    params: { width: size[0], height: size[1], depth: size[2] },
    transform: { position, rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    seed: 7,
    materialId: "oak",
  };
}

const chairSpec: SceneSpec = {
  version: 1,
  id: CHAIR_ID,
  seed: 7,
  units: "m",
  axes: "y-up",
  root: "chair",
  nodes: [
    {
      id: "chair",
      name: "Oak chair",
      kind: "group",
      transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      children: CHAIR_NODES.slice(1),
    },
    chairBox("seat", "Chair seat", [0, 0.56, 0], [0.8, 0.12, 0.8]),
    chairBox("backrest", "Chair backrest", [0, 0.94, -0.34], [0.8, 0.7, 0.08]),
    chairBox("front-left", "Front left leg", [-0.32, 0.25, 0.32], [0.08, 0.5, 0.08]),
    chairBox("front-right", "Front right leg", [0.32, 0.25, 0.32], [0.08, 0.5, 0.08]),
    chairBox("back-left", "Back left leg", [-0.32, 0.25, -0.32], [0.08, 0.5, 0.08]),
    chairBox("back-right", "Back right leg", [0.32, 0.25, -0.32], [0.08, 0.5, 0.08]),
  ],
  materials: [{ id: "oak", name: "Oak", color: "#9a663b", metalness: 0, roughness: 0.82 }],
};

describe("offline chair pipeline", () => {
  it("creates, edits, validates, preserves and renders a chair across two turns", async () => {
    const sessionId = crypto.randomUUID();
    const turnIds = [crypto.randomUUID(), crypto.randomUUID()];
    const manager = new InMemorySandboxManager();
    const sandboxResult = await manager.create("chair-pipeline");
    if (!sandboxResult.ok) throw new Error(sandboxResult.error.message);
    const events: StoredEvent[] = [];
    const provider = new ScriptedLLMProvider([
      [
        {
          toolCalls: [
            {
              id: "create-chair",
              name: "propose_scene_patch",
              input: {
                spec: chairSpec,
                rationale: "Create a compact oak chair with a seat, backrest, and four legs.",
              },
            },
          ],
        },
        { text: "Created the oak chair scene." },
      ],
      [
        { toolCalls: [{ id: "read-chair", name: "get_scene", input: {} }] },
        {
          toolCalls: [
            {
              id: "add-cushion",
              name: "propose_scene_patch",
              input: {
                baseHash: hashSceneSpec(chairSpec),
                rationale: "Add a fitted forest-green cushion centered on the seat.",
                ops: [
                  {
                    op: "add_material",
                    material: {
                      id: "green",
                      name: "Forest green fabric",
                      color: "#2f6f4e",
                      metalness: 0,
                      roughness: 0.96,
                    },
                  },
                  {
                    op: "add_node",
                    parentId: "chair",
                    node: {
                      id: "cushion",
                      name: "Forest green cushion",
                      kind: "procedural",
                      op: "box",
                      params: { width: 0.68, height: 0.08, depth: 0.68, bevel: 0.02 },
                      transform: {
                        position: [0, 0.66, 0],
                        rotationEuler: [0, 0, 0],
                        scale: [1, 1, 1],
                      },
                      seed: 8,
                      materialId: "green",
                    },
                  },
                ],
              },
            },
          ],
        },
        { text: "Added the cushion without changing the chair frame." },
      ],
    ]);
    const agent = new NapAgentService({ provider });
    const append = (event: PendingEvent) => {
      events.push({ ...event, seq: events.length } as StoredEvent);
    };
    const request = (turnId: string, prompt: string) => ({
      sessionId,
      turnId,
      sandboxId: sandboxResult.value.id,
      sandbox: manager,
      context: {
        systemPrompt: "You are the Vibe-VR scene agent.",
        messages: [{ role: "user" as const, content: prompt }],
        estimatedTokens: 32,
      },
      onEvent: append,
      readSessionEvents: async (id: string) => events.filter((event) => event.sessionId === id),
    });

    await agent.runTurn(request(turnIds[0]!, "Create a simple wooden chair."));
    const firstHead = readSceneHead(events);
    expect(firstHead?.spec.nodes.map((node) => node.id)).toEqual(CHAIR_NODES);
    await agent.runTurn(
      request(turnIds[1]!, "Add a forest-green cushion centered on the chair seat."),
    );

    const updates = events.filter((event) => event.type === "scene.updated");
    expect(updates).toHaveLength(2);
    if (updates[1]?.type !== "scene.updated")
      throw new Error("the cushion revision was not emitted");
    expect(updates[1].payload.parentHash).toBe(hashSceneSpec(chairSpec));
    const head = readSceneHead(events);
    expect(head).not.toBeNull();
    const edited = head!.spec;
    expect(edited.nodes.map((node) => node.id)).toEqual([...CHAIR_NODES, "cushion"]);
    expect(edited.materials.find((material) => material.id === "green")?.color).toBe("#2f6f4e");

    const built = buildScene(edited);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error.message);
    const renderGroup = builtSceneToGroup(built.value);
    expect(renderGroup.children).toHaveLength(7);
    expect(built.value.triangleCount).toBeGreaterThan(0);
    disposeGroup(renderGroup);
    expect(renderGroup.children).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "get_scene",
      "propose_scene_patch",
      "propose_desk",
    ]);
    expect(provider.requests[2]?.sceneContext).toContain("world bounds=");
  });
});
