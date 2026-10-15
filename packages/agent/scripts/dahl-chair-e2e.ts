import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NapAgentService } from "@vibe-vr/agent/agent-service";
import { DAHL_MODELS, DahlProvider } from "@vibe-vr/agent/dahl-provider";
import { buildScene } from "@vibe-vr/procedural/build";
import { builtSceneToGroup, disposeGroup } from "@vibe-vr/procedural/three-adapter";
import { InMemorySandboxManager } from "@vibe-vr/sandbox/testing/in-memory-sandbox-manager";
import { validateSceneSpec } from "@vibe-vr/scene-spec/schema";
import { formatBounds, sceneBounds } from "@vibe-vr/scene-spec/spatial";
import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";

const envPath = resolve(import.meta.dir, "../../../apps/api/.env");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const apiKey =
  process.env.DAHL_API_KEY ??
  envText
    .split(/\r?\n/)
    .find((line) => line.startsWith("DAHL_API_KEY="))
    ?.slice("DAHL_API_KEY=".length)
    .trim();
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("DAHL_API_KEY is not configured in apps/api/.env");
}

const sessionId = crypto.randomUUID();
const manager = new InMemorySandboxManager();
const sandboxResult = await manager.create("dahl-chair-e2e");
if (!sandboxResult.ok) throw new Error(sandboxResult.error.message);
const events: StoredEvent[] = [];
const fetcher: typeof fetch = async (input, init) => {
  const requestBody = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
  const startedAt = Date.now();
  console.log(JSON.stringify({ dahlRequest: requestBody.model ?? "unknown" }));
  try {
    const response = await fetch(input, init);
    console.log(
      JSON.stringify({
        dahlResponse: requestBody.model ?? "unknown",
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        elapsedMs: Date.now() - startedAt,
      }),
    );
    if (response.ok) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        choices?: Array<{
          finish_reason?: string;
          message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
        }>;
      } | null;
      const message = body?.choices?.[0]?.message;
      const args =
        message?.tool_calls?.map((toolCall) => {
          const value = toolCall.function?.arguments ?? "";
          try {
            JSON.parse(value);
            return {
              tool: toolCall.function?.name,
              argumentsValidJson: true,
              length: value.length,
            };
          } catch {
            return {
              tool: toolCall.function?.name,
              argumentsValidJson: false,
              length: value.length,
              head: value.slice(0, 140).split(apiKey).join("[redacted]"),
              tail: value.slice(-140).split(apiKey).join("[redacted]"),
            };
          }
        }) ?? [];
      console.log(
        JSON.stringify({ finishReason: body?.choices?.[0]?.finish_reason, toolArguments: args }),
      );
    }
    return response;
  } catch (error) {
    console.log(
      JSON.stringify({
        dahlNetworkError: requestBody.model ?? "unknown",
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    throw error;
  }
};

const provider = new DahlProvider({
  apiKey,
  primaryModel: DAHL_MODELS.primary,
  spatialModel: DAHL_MODELS.spatial,
  compositionModel: DAHL_MODELS.composition,
  requestTimeoutMs: 120_000,
  maxAttempts: 1,
  maxConcurrency: 3,
  maxParallelAgents: 2,
  maxOrchestrationRounds: 1,
  maxCompletionTokens: 6_000,
  fetcher,
});
const agent = new NapAgentService({ provider, budget: { maxSteps: 12, maxTokens: 80_000 } });

function logSummary(label: string, before: number, turnId: string) {
  const updated = events.filter(
    (event) => event.turnId === turnId && event.type === "scene.updated",
  );
  const failures = events.filter(
    (event) => event.turnId === turnId && event.type === "turn.failed",
  );
  const completion = events.find(
    (event) => event.turnId === turnId && event.type === "turn.completed",
  );
  const activities = events.flatMap((event) =>
    event.turnId === turnId && event.type === "system.notice" ? [event.payload.text] : [],
  );
  console.log(
    JSON.stringify({
      label,
      eventCount: events.length - before,
      acceptedSceneRevisions: updated.length,
      completion: completion?.type === "turn.completed" ? completion.payload : null,
      failures: failures.map((event) => (event.type === "turn.failed" ? event.payload : null)),
      activities,
    }),
  );
}

async function runTurn(prompt: string, label: string): Promise<boolean> {
  const before = events.length;
  const turnId = crypto.randomUUID();
  await agent.runTurn({
    sessionId,
    turnId,
    sandboxId: sandboxResult.value.id,
    sandbox: manager,
    context: {
      systemPrompt:
        "You are Vibe-VR's scene editing agent. Follow the 3D-scene-editing instructions and use its validated tools.",
      messages: [{ role: "user", content: prompt }],
      estimatedTokens: 30,
    },
    readSessionEvents: async () => [...events],
    onEvent: (event) => {
      events.push({ ...event, seq: events.length + 1 } as StoredEvent);
      if (event.type === "system.notice")
        console.log(JSON.stringify({ activity: event.payload.text }));
      if (event.type === "scene.updated")
        console.log(JSON.stringify({ sceneAccepted: event.payload.specHash }));
      if (event.type === "scene.rejected")
        console.log(
          JSON.stringify({
            sceneRejected: event.payload.code,
            diagnostics: event.payload.diagnostics.slice(0, 500),
          }),
        );
      if (event.type === "tool.call" && event.payload.toolName === "propose_scene_patch") {
        const input = event.payload.input;
        const spec =
          typeof input.spec === "object" && input.spec !== null
            ? (input.spec as Record<string, unknown>)
            : undefined;
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
        console.log(
          JSON.stringify({
            toolCall: event.payload.toolName,
            topLevelKeys: Object.keys(input),
            specKeys: spec === undefined ? [] : Object.keys(spec),
            nodes: nodes.map((node) => {
              const item =
                typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
              return {
                id: item.id,
                name: item.name,
                kind: item.kind,
                op: item.op,
                transformKeys:
                  typeof item.transform === "object" && item.transform !== null
                    ? Object.keys(item.transform)
                    : [],
                paramsKeys:
                  typeof item.params === "object" && item.params !== null
                    ? Object.keys(item.params)
                    : [],
              };
            }),
            opsCount: Array.isArray(input.ops) ? input.ops.length : null,
          }),
        );
      }
      if (event.type === "tool.result")
        console.log(
          JSON.stringify({
            toolResult: event.payload.toolName,
            ok: event.payload.ok,
            output: event.payload.output.slice(0, 350),
          }),
        );
      if (event.type === "turn.failed")
        console.log(
          JSON.stringify({ turnFailed: event.payload.reason, message: event.payload.message }),
        );
    },
  });
  logSummary(label, before, turnId);
  return events.some((event) => event.turnId === turnId && event.type === "scene.updated");
}

function renderHead(label: string, previousIds: Set<string> = new Set()): Set<string> {
  const update = [...events].reverse().find((event) => event.type === "scene.updated");
  if (update?.type !== "scene.updated") throw new Error(`${label}: no accepted scene revision`);
  const parsed = validateSceneSpec(update.payload.spec);
  if (!parsed.ok) throw new Error(`${label}: invalid SceneSpec: ${parsed.error.message}`);

  const built = buildScene(parsed.value);
  if (!built.ok) throw new Error(`${label}: render build failed: ${built.error.message}`);
  const renderGroup = builtSceneToGroup(built.value);
  const ids = new Set(parsed.value.nodes.map((node) => node.id));
  const preserved = [...previousIds].filter((id) => ids.has(id));
  const nodeSummary = parsed.value.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    ...(node.kind === "procedural"
      ? {
          geometry: node.op,
          material: node.materialId,
          params: node.params,
          transform: node.transform,
        }
      : {}),
  }));
  const materialSummary = parsed.value.materials.map((material) => ({
    id: material.id,
    name: material.name,
    color: material.color,
  }));

  console.log(
    JSON.stringify({
      label,
      revision: update.payload.specHash,
      parentRevision: update.payload.parentHash,
      nodes: nodeSummary,
      materials: materialSummary,
      sceneBounds: formatBounds(sceneBounds(parsed.value)),
      renderedMeshes: renderGroup.children.length,
      triangleCount: built.value.triangleCount,
      rendererBounds: built.value.bounds,
      preservedNodeIds: preserved,
    }),
  );
  disposeGroup(renderGroup);
  if (renderGroup.children.length !== 0)
    throw new Error(`${label}: renderer resources were not released`);
  return ids;
}

const chairAccepted = await runTurn(
  "Create a simple wooden chair with a seat, a backrest, and four stable legs. Keep it compact and structurally plausible.",
  "chair creation",
);
if (!chairAccepted) {
  console.error("Dahl did not return an accepted chair scene in this attempt.");
  process.exit(1);
}
const originalIds = renderHead("chair render");

const editAccepted = await runTurn(
  "Add a forest-green cushion centered on the chair seat. Keep the chair's seat and all four legs, and make the cushion fit within the seat.",
  "multi-agent cushion edit",
);
if (!editAccepted) {
  console.error("Dahl did not return an accepted cushion edit in this attempt.");
  process.exit(1);
}
const editedIds = renderHead("edited chair render", originalIds);
const preservedOriginals = [...originalIds].filter((id) => editedIds.has(id));
if (preservedOriginals.length !== originalIds.size) {
  throw new Error(
    `The edit did not preserve every original chair node (${preservedOriginals.length}/${originalIds.size}).`,
  );
}
const editedSpec = readSceneHead(events)?.spec;
if (editedSpec === undefined) throw new Error("The edited chair scene is missing.");
const cushion = editedSpec.nodes.find(
  (node) => node.kind === "procedural" && node.name.toLowerCase().includes("cushion"),
);
if (cushion?.kind !== "procedural") throw new Error("The edit did not add a procedural cushion.");
const cushionMaterial = editedSpec.materials.find((material) => material.id === cushion.materialId);
if (cushionMaterial === undefined) throw new Error("The cushion has no validated material.");
const color = cushionMaterial.color.slice(1);
const red = Number.parseInt(color.slice(0, 2), 16);
const green = Number.parseInt(color.slice(2, 4), 16);
const blue = Number.parseInt(color.slice(4, 6), 16);
if (green <= red || green <= blue) {
  throw new Error(`The cushion material is not green: ${cushionMaterial.color}`);
}
