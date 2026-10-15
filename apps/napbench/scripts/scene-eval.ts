/**
 * Live scene-proposal evaluation: the eight evaluation cases against a real
 * model through the real agent loop.
 *
 * Dry run by default: `bun apps/napbench/scripts/scene-eval.ts` prints what a
 * live run would do — provider, model, prompts, expected call counts — and
 * spends nothing. Append `--real` to actually send requests; that needs
 * `OPENROUTER_API_KEY` (in the environment or `apps/api/.env`) and spends
 * real money, so the key's presence is checked before anything else.
 *
 * Each case runs as one turn of `NapAgentService` on a single shared session,
 * exactly like consecutive user requests: the log accumulates, later cases
 * fold earlier ones, and staleness behaves as it does in production. Results
 * print as JSON rows in the offline suite's report shape, plus the model's
 * prose and per-turn usage, so live and fixture runs compare field for field.
 *
 * Contract note, measured by the offline suite: `get_scene` renders both a
 * short display hash and the full `revision` hash, and proposals must cite
 * the full one — a model citing only the prefix is refused before validation.
 * This runner records how often each outcome occurs in practice.
 */

import { randomUUID } from "node:crypto";
import { NapAgentService } from "@vibe-vr/agent/agent-service";
import { ClaudeProvider, DEFAULT_MODEL_CONFIG } from "@vibe-vr/agent/claude-provider";
import { createOpenRouterClient, toOpenRouterModel } from "@vibe-vr/agent/openrouter";
import { type CaseReport, EVAL_CASES, summarize } from "@vibe-vr/agent/scene-eval/cases";
import { buildScene } from "@vibe-vr/procedural/build";
import { InMemorySandboxManager } from "@vibe-vr/sandbox/testing/in-memory-sandbox-manager";
import { foldSceneSpec } from "@vibe-vr/scene-spec/fold";
import { AnySceneProposalSchema } from "@vibe-vr/scene-spec/proposal";
import { sceneLogEvents } from "@vibe-vr/scene-spec/scene-events";
import type { SceneSpec } from "@vibe-vr/scene-spec/schema";
import { loadEnvFile } from "@vibe-vr/shared/env-file";
import type { NapEvent, NapEventType } from "@vibe-vr/shared/events";
import type { PendingEvent, StoredEvent } from "@vibe-vr/shared/ports/event-store";

const PROVIDER = "openrouter";
const SESSION_ID = randomUUID();
const ESTIMATED_TOKENS = 2000;
/** Enough for read-then-propose with a few retries; a cap, not a target. */
const MAX_STEPS = 12;

const SYSTEM_PROMPT = [
  "You are a 3D scene designer working through scene tools.",
  "Use get_scene to read the current scene, then propose_scene_patch to change it.",
  "Closed operation vocabulary: set_param, set_transform, set_material, rename, add_node, remove_node.",
  "Cite the revision hash get_scene returned as baseHash, and include a short rationale.",
  "Work only with the scene tools. Do not read files, run commands, or describe geometry in prose instead of proposing.",
].join(" ");

const args = process.argv.slice(2);
const real = args.includes("--real");
const modelFlag = args.find((arg) => arg.startsWith("--model="));
const model =
  modelFlag === undefined ? DEFAULT_MODEL_CONFIG.model : modelFlag.slice("--model=".length);

function plan(): string {
  return [
    `Provider: ${PROVIDER} (OpenRouter Anthropic-shaped endpoint).`,
    `Model: ${model}${modelFlag === undefined ? " (project default)" : " (flag override)"}.`,
    `Cases: ${EVAL_CASES.length}, one turn each on a single chained session.`,
    ...EVAL_CASES.map(
      (evaluation, index) => `  ${index + 1}. [${evaluation.id}] ${evaluation.prompt}`,
    ),
    "Expected traffic: 2-4 model requests per case (read, propose, possible retries), 16-32 total.",
    "Cost: vendor rates at runtime against the usage this script prints; small either way, real either way.",
    "Credentials: OPENROUTER_API_KEY in the environment or apps/api/.env (presence checked, value never printed).",
  ].join("\n");
}

if (!real) {
  console.log(["Dry run — nothing sent, nothing spent.", "", plan()].join("\n"));
  process.exit(0);
}

loadEnvFile("apps/api/.env", process.env);
if (!process.env.OPENROUTER_API_KEY) {
  console.log(
    [
      "Live evaluation blocked: OPENROUTER_API_KEY is not set.",
      "Put it in the environment or apps/api/.env, then re-run with --real.",
      "",
      plan(),
    ].join("\n"),
  );
  process.exit(2);
}

type LiveExtras = {
  prose: string[];
  turnFailed: string | null;
};

async function runCase(
  evaluation: (typeof EVAL_CASES)[number],
  agent: NapAgentService,
  sandbox: InMemorySandboxManager,
  sandboxId: string,
  log: StoredEvent[],
): Promise<{ report: CaseReport; extras: LiveExtras }> {
  const turnId = randomUUID();
  const beforeLength = log.length;
  const headBefore = foldSceneSpec(sceneLogEvents(log))?.hash ?? null;
  const beforeSpec: SceneSpec | null = foldSceneSpec(sceneLogEvents(log))?.spec ?? null;
  const prose: string[] = [];
  let turnFailed: string | null = null;

  await agent.runTurn({
    sessionId: SESSION_ID,
    turnId,
    sandboxId,
    sandbox,
    context: {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: evaluation.prompt }],
      estimatedTokens: ESTIMATED_TOKENS,
    },
    onEvent: (event: PendingEvent) => {
      if (event.type === "agent.message" && typeof event.payload.text === "string") {
        prose.push(event.payload.text);
      }
      if (event.type === "turn.failed") turnFailed = event.payload.reason;
      log.push({ ...event, sessionId: SESSION_ID, turnId, seq: log.length } as StoredEvent);
    },
    readSessionEvents: async () => log,
    model,
  });

  const turn = log.slice(beforeLength);
  const ofType = <T extends NapEventType>(type: T): Extract<NapEvent, { type: T }>[] =>
    turn.filter((event): event is Extract<NapEvent, { type: T }> => event.type === type);
  const calls = ofType("tool.call");
  const results = ofType("tool.result");
  const proposes = calls.filter((event) => event.payload.toolName === "propose_scene_patch");
  const updatesBefore = log
    .slice(0, beforeLength)
    .filter((event) => event.type === "scene.updated").length;
  const updatesNow = log.filter((event) => event.type === "scene.updated").length;
  const accepted = updatesNow > updatesBefore;
  const rejection = [...turn].reverse().find((event) => event.type === "scene.rejected");
  const failedPropose = results.some(
    (event) => !event.payload.ok && event.payload.toolName === "propose_scene_patch",
  );
  const head = foldSceneSpec(sceneLogEvents(log));
  const headAfter = head?.hash ?? null;
  return {
    report: {
      caseId: evaluation.id,
      kind: evaluation.kind,
      prompt: evaluation.prompt,
      model,
      toolCalls: calls.map((event) => ({
        name: event.payload.toolName,
        ok: !results.some(
          (result) => result.payload.toolCallId === event.payload.toolCallId && !result.payload.ok,
        ),
      })),
      parses: proposes.every(
        (event) => AnySceneProposalSchema.safeParse(event.payload.input).success,
      ),
      accepted,
      rejectionCode:
        rejection?.type === "scene.rejected" && typeof rejection.payload.code === "string"
          ? rejection.payload.code
          : failedPropose
            ? "invalid_arguments"
            : null,
      headBefore,
      headAfter,
      reconstructed: head !== null && buildScene(head.spec).ok,
      checks: evaluation.check(beforeSpec, head?.spec ?? null),
      turns: 1,
      retries: results.filter((event) => !event.payload.ok).length,
      usage: ofType("turn.completed").reduce(
        (sum, event) => ({
          inputTokens: sum.inputTokens + (event.payload.usage.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (event.payload.usage.outputTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 },
      ),
    },
    extras: { prose, turnFailed },
  };
}

const sandbox = new InMemorySandboxManager();
const created = await sandbox.create("scene-eval");
if (!created.ok) throw new Error(created.error.message);
const provider = new ClaudeProvider({
  client: createOpenRouterClient(),
  model: toOpenRouterModel(model),
});
const agent = new NapAgentService({ provider, budget: { maxSteps: MAX_STEPS } });
const log: StoredEvent[] = [];
const rows: (CaseReport & LiveExtras)[] = [];
for (const evaluation of EVAL_CASES) {
  const { report, extras } = await runCase(evaluation, agent, sandbox, created.value.id, log);
  rows.push({ ...report, ...extras });
}

console.log(
  JSON.stringify(
    {
      provider: PROVIDER,
      model,
      sessionId: SESSION_ID,
      cases: rows,
      metrics: summarize(rows),
      usage: {
        inputTokens: rows.reduce((sum, row) => sum + row.usage.inputTokens, 0),
        outputTokens: rows.reduce((sum, row) => sum + row.usage.outputTokens, 0),
      },
    },
    null,
    2,
  ),
);
