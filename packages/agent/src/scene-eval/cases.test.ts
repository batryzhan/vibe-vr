/**
 * Offline scene-proposal evaluation: authored model traffic through the real
 * tool, validation, fold, and build path.
 *
 * Each case in the suite replays fixed tool traffic — the exact shape a model
 * turn emits — against `executeTool`, folds the emitted events, rebuilds the
 * head into geometry, and runs the case's numeric acceptance checks. No
 * network, no credentials, fully deterministic: the same cases a live run will
 * execute, with the model replaced by fixtures.
 *
 * The live run reuses the cases and the report shape and replaces `model:
 * "fixture"` with its id. A live trajectory that the offline suite accepts
 * but the checks dispute is a model failure, not a pipeline failure — that
 * separation is the point of recording correctness and quality apart.
 */

import { buildScene } from "@vibe-vr/procedural/build";
import { InMemorySandboxManager } from "@vibe-vr/sandbox/testing/in-memory-sandbox-manager";
import { foldSceneSpec } from "@vibe-vr/scene-spec/fold";
import { AnySceneProposalSchema } from "@vibe-vr/scene-spec/proposal";
import { hashSceneSpec } from "@vibe-vr/scene-spec/revisions";
import { sceneLogEvents } from "@vibe-vr/scene-spec/scene-events";
import type { SceneSpec } from "@vibe-vr/scene-spec/schema";
import type { PendingEvent, StoredEvent } from "@vibe-vr/shared/ports/event-store";
import type { LLMToolCall } from "@vibe-vr/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { executeTool, type ToolContext } from "../tools/execute.ts";
import { type CaseReport, EVAL_CASES, type EvalCase, makeDeskGenesis, summarize } from "./cases.ts";

const SESSION_ID = "5e9f2b44-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "8d9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const CREATED_AT = "2026-10-05T00:00:00.000Z";

function genesisEvent(spec: SceneSpec): StoredEvent {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    seq: 0,
    createdAt: CREATED_AT,
    type: "scene.updated",
    payload: { spec, parentHash: null, specHash: hashSceneSpec(spec) },
  };
}

/** Runs one case's traffic and returns its report row. */
async function runCase(
  evaluation: EvalCase,
  sandbox: InMemorySandboxManager,
  sandboxId: string,
): Promise<CaseReport> {
  const base = evaluation.baseSpec();
  const log: StoredEvent[] = base === null ? [] : [genesisEvent(base)];
  const pending: PendingEvent[] = [];
  const flush = (): void => {
    for (const event of pending.splice(0)) {
      log.push({
        ...event,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        seq: log.length,
      } as StoredEvent);
    }
  };
  const ctx: ToolContext = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox,
    emit: (event) => {
      pending.push(event);
    },
    readSessionEvents: async () => {
      flush();
      return log;
    },
    now: () => CREATED_AT,
  };

  flush();
  const headBefore = foldSceneSpec(sceneLogEvents(log))?.hash ?? null;
  const countOf = (type: "scene.updated" | "scene.rejected"): number =>
    log.filter((event) => event.type === type).length;
  const updatesBefore = countOf("scene.updated");
  const rejectionsBefore = countOf("scene.rejected");
  const traffic = evaluation.traffic(headBefore);
  const toolCalls: { name: string; ok: boolean }[] = [];
  let parses = true;
  let retries = 0;
  let proposeFailed = false;
  let callIndex = 0;
  for (const item of traffic) {
    callIndex += 1;
    const call: LLMToolCall = { id: `toolu_eval_${callIndex}`, name: item.name, input: item.input };
    if (item.name === "propose_scene_patch") {
      parses = parses && AnySceneProposalSchema.safeParse(item.input).success;
    }
    const outcome = await executeTool(call, ctx);
    toolCalls.push({ name: item.name, ok: outcome.ok });
    if (!outcome.ok) retries += 1;
    if (item.name === "propose_scene_patch" && !outcome.ok) proposeFailed = true;
  }
  flush();

  const accepted = countOf("scene.updated") > updatesBefore;
  const rejection =
    countOf("scene.rejected") > rejectionsBefore
      ? log.findLast((event) => event.type === "scene.rejected")
      : undefined;
  const head = foldSceneSpec(sceneLogEvents(log));
  const headAfter = head?.hash ?? null;
  let reconstructed = false;
  if (head !== null) {
    reconstructed = buildScene(head.spec).ok;
  }
  return {
    caseId: evaluation.id,
    kind: evaluation.kind,
    prompt: evaluation.prompt,
    model: "fixture",
    toolCalls,
    parses,
    accepted,
    // A schema-invalid propose never reaches validation, so no scene.rejected
    // exists for it: the refusal is the failed tool result itself, with zero
    // scene events beside it.
    rejectionCode:
      rejection?.type === "scene.rejected" && typeof rejection.payload.code === "string"
        ? rejection.payload.code
        : proposeFailed
          ? "invalid_arguments"
          : null,
    headBefore,
    headAfter,
    reconstructed,
    checks: evaluation.check(base, head?.spec ?? null),
    turns: 1,
    retries,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("scene-proposal evaluation (offline fixtures)", () => {
  let sandbox: InMemorySandboxManager;
  let sandboxId: string;
  let reports: CaseReport[];

  beforeEach(async () => {
    sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("eval-project");
    if (!created.ok) throw new Error(created.error.message);
    sandboxId = created.value.id;
    reports = [];
    for (const evaluation of EVAL_CASES) {
      reports.push(await runCase(evaluation, sandbox, sandboxId));
    }
  });

  it("covers the eight evaluation cases", () => {
    expect(EVAL_CASES.map((evaluation) => evaluation.id)).toEqual([
      "genesis-desk",
      "widen-20",
      "add-lamp",
      "remove-lamp",
      "walnut-lower-10",
      "monitor-centered",
      "ambiguous-stale",
      "unsupported-op",
    ]);
    expect(reports).toHaveLength(8);
  });

  it("accepts every valid proposal through the real tool path", () => {
    for (const report of reports.filter((item) => item.kind !== "refused")) {
      expect(report.accepted, report.caseId).toBe(true);
      expect(report.rejectionCode, report.caseId).toBeNull();
      expect(report.reconstructed, report.caseId).toBe(true);
      for (const check of report.checks) {
        expect(check.pass, `${report.caseId}/${check.name}: ${check.detail}`).toBe(true);
      }
    }
  });

  it("refuses invalid and unsupported traffic without moving the head", () => {
    for (const report of reports.filter((item) => item.kind === "refused")) {
      expect(report.accepted, report.caseId).toBe(false);
      expect(report.rejectionCode, report.caseId).not.toBeNull();
      expect(report.headAfter, report.caseId).toBe(report.headBefore);
      expect(
        report.checks.every((check) => check.pass),
        report.caseId,
      ).toBe(true);
    }
  });

  it("the invented operation fails the proposal schema, not just validation", () => {
    const unsupported = reports.find((report) => report.caseId === "unsupported-op");
    expect(unsupported?.parses).toBe(false);
    const stale = reports.find((report) => report.caseId === "ambiguous-stale");
    // Well-formed but stale: schema passes, validation refuses.
    expect(stale?.parses).toBe(true);
    expect(stale?.rejectionCode).toBe("stale_base");
  });

  it("aggregates the required evaluation metrics", () => {
    const metrics = summarize(reports);
    expect(metrics.cases).toBe(8);
    expect(metrics.validityRate).toBe(1);
    expect(metrics.schemaRate).toBeCloseTo(7 / 8);
    expect(metrics.reconstructionRate).toBe(1);
    expect(metrics.editSuccessRate).toBe(1);
    expect(metrics.rejectionRate).toBe(1);
    expect(metrics.totalTurns).toBe(8);
  });

  it("refuses the 12-character prefix but accepts the exposed full revision hash", async () => {
    // get_scene shows a short display hash and a full `revision` hash; patches
    // must cite the latter. Both halves are pinned: the prefix alone is
    // refused with zero scene events, while the exposed full hash validates
    // and moves the head exactly once.
    // get_scene advertises "the revision hash your patch must cite" but renders
    // twelve characters; proposals require sixty-four. A model that trusts the
    // tool output is refused, so chained live edits cannot succeed until the
    // full hash is visible to the model. Pinned here as measured evidence.
    const base = makeDeskGenesis();
    const log: StoredEvent[] = [genesisEvent(base)];
    const seen: PendingEvent[] = [];
    const ctx: ToolContext = {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      sandboxId,
      sandbox,
      emit: (event) => {
        seen.push(event);
      },
      readSessionEvents: async () => log,
      now: () => CREATED_AT,
    };
    const read = await executeTool({ id: "toolu_pin_1", name: "get_scene", input: {} }, ctx);
    expect(read.ok).toBe(true);
    const rendered = /Scene ([0-9a-f]{12})/.exec(read.output)?.[1];
    expect(rendered).not.toBeUndefined();
    if (rendered === undefined) throw new Error("get_scene rendered no hash");
    const attempt = await executeTool(
      {
        id: "toolu_pin_2",
        name: "propose_scene_patch",
        input: {
          baseHash: rendered,
          ops: [{ op: "set_param", nodeId: "top", key: "width", value: 2 }],
          rationale: "Citing exactly what get_scene showed.",
        },
      },
      ctx,
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.output).toMatch(/Invalid arguments for propose_scene_patch/);
    expect(seen.filter((event) => event.type === "scene.updated")).toHaveLength(0);
    expect(seen.filter((event) => event.type === "scene.rejected")).toHaveLength(0);
    expect(foldSceneSpec(sceneLogEvents(log))?.hash).toBe(hashSceneSpec(base));

    const full = /revision ([0-9a-f]{64})/.exec(read.output)?.[1];
    expect(full).toBe(hashSceneSpec(base));
    const retry = await executeTool(
      {
        id: "toolu_pin_3",
        name: "propose_scene_patch",
        input: {
          baseHash: full,
          ops: [{ op: "set_param", nodeId: "top", key: "width", value: 2 }],
          rationale: "Citing the exposed full revision.",
        },
      },
      ctx,
    );
    expect(retry.ok).toBe(true);
    const [update] = seen.filter((event) => event.type === "scene.updated");
    expect(update).toMatchObject({ payload: { parentHash: hashSceneSpec(base) } });
  });
});
