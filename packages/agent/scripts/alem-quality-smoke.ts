/** Live demo rehearsal: a short prompt must produce a validated, renderable scene. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildScene } from "@vibe-vr/procedural/build";
import { InMemorySandboxManager } from "@vibe-vr/sandbox/testing/in-memory-sandbox-manager";
import type { StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { NapAgentService } from "../src/agent-service.ts";
import { AlemProvider } from "../src/alem-provider.ts";

const env = readFileSync(resolve(import.meta.dir, "../../../apps/api/.env"), "utf8");
const apiKey = env
  .split(/\r?\n/)
  .find((line) => line.startsWith("ALEM_API_KEY="))
  ?.slice(13)
  .trim();
if (!apiKey) throw new Error("Missing ALEM_API_KEY");
const prompt = process.argv[2] ?? "Сделай мне стул";
const referenceImage = process.env.REFERENCE_IMAGE_FILE
  ? `data:image/png;base64,${readFileSync(process.env.REFERENCE_IMAGE_FILE).toString("base64")}`
  : undefined;
const sandbox = new InMemorySandboxManager();
const created = await sandbox.create("alem-quality-smoke");
if (!created.ok) throw new Error(created.error.message);
const events: StoredEvent[] = [];
let calls = 0;
const provider = new AlemProvider({
  apiKey,
  fetcher: async (input, init) => {
    calls++;
    const response = await fetch(input, init);
    const body = (await response.clone().json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function: { name: string } }> } }>;
    };
    console.log(
      JSON.stringify({
        call: calls,
        tools: body.choices?.[0]?.message?.tool_calls?.map((tool) => tool.function.name),
      }),
    );
    return response;
  },
});
const started = Date.now();
await new NapAgentService({ provider, budget: { maxSteps: 4, maxTokens: 40_000 } }).runTurn({
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  sandboxId: created.value.id,
  sandbox,
  ...(referenceImage === undefined ? {} : { referenceImage }),
  context: {
    systemPrompt: "You are Vibe-VR's 3D product designer. Use the validated scene tools.",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    estimatedTokens: 30,
  },
  readSessionEvents: async () => [...events],
  onEvent: (event) => {
    events.push({ ...event, seq: events.length + 1 } as StoredEvent);
    if (event.type === "scene.rejected")
      console.log(JSON.stringify({ rejected: event.payload.diagnostics }));
  },
});
const update = events.findLast((event) => event.type === "scene.updated");
const failure = events.find((event) => event.type === "turn.failed");
if (update?.type !== "scene.updated" || failure?.type === "turn.failed") {
  console.log(
    JSON.stringify({ failure: failure?.payload, calls, elapsedMs: Date.now() - started }),
  );
  process.exit(1);
}
const built = buildScene(update.payload.spec);
if (!built.ok) throw new Error(built.error.message);
const report = {
  prompt,
  calls,
  elapsedMs: Date.now() - started,
  nodes: update.payload.spec.nodes.length,
  materials: update.payload.spec.materials.length,
  renderable: true,
  spec: update.payload.spec,
};
const directory = resolve(import.meta.dir, "../../../.nap-objects/demo-quality");
mkdirSync(directory, { recursive: true });
writeFileSync(
  resolve(directory, referenceImage ? "latest-image.json" : "latest.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ ...report, spec: undefined }));
