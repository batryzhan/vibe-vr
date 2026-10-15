"use client";

/**
 * WebSocket stream hook for the multi-model 11-state turn pipeline.
 *
 * Consumes all 9 TurnStreamEvent frames from packages/shared/src/ws-protocol.ts:
 * - turn.state_changed: Tracks 11 lifecycle states and records timeline transitions.
 * - turn.needs_input: Pauses for user clarification with ambiguity reasons and questions.
 * - turn.plan_ready: Populates atomic step decomposition from Scene Planner.
 * - turn.step_started: Tracks active step, attempt budget (1..3), and active model.
 * - turn.gate_result: Tracks 3-gate verification (Gate 1 JSON, Gate 2 Schema/AABB, Gate 3 Vision)
 *   and retains diagnostic history for repair inspection.
 * - turn.step_committed: Advances progress and emits sceneDelta and newRevision for viewport updates.
 * - turn.stale_rebase: Tracks optimistic concurrency rebase notifications.
 * - turn.completed: Concludes the turn with final revision.
 * - turn.failed: Concludes with failure reason and failed step identifier.
 */

import {
  type ServerFrame,
  ServerFrameSchema,
  type TurnStreamEvent,
} from "@vibe-vr/shared/ws-protocol";

export type { TurnStreamEvent };
import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateSocket, StreamSocket } from "./use-event-stream.ts";

export type TurnState =
  | "queued"
  | "planning_scene"
  | "needs_input"
  | "planning_geometry"
  | "building"
  | "verifying"
  | "applying"
  | "stale"
  | "completed"
  | "failed"
  | "cancelled";

export type GateNumber = 1 | 2 | 3;

export type GateEvaluation = {
  passed: boolean;
  diagnostics?: string;
};

export type AttemptHistory = {
  attempt: number;
  model: string | null;
  gates: Record<GateNumber, GateEvaluation | null>;
};

export type StepPlanItem = {
  stepIndex: number;
  stepId: string;
  goal: string;
  status: "pending" | "active" | "committed" | "failed";
  attempt: number;
  activeModel: string | null;
  gates: Record<GateNumber, GateEvaluation | null>;
  history: AttemptHistory[];
};

export type TurnPlan = {
  sceneSummary: string;
  totalSteps: number;
  steps: StepPlanItem[];
};

export type ClarificationState = {
  turnId: string;
  ambiguityReason: string;
  questions: string[];
};

export type RebaseAlert = {
  turnId: string;
  expectedRevision: number;
  actualRevision: number;
  rebaseAttempt: number;
};

export type TimelineEntry = {
  from: string;
  to: string;
  timestamp: string;
};

export type TurnStreamState = {
  turnId: string | null;
  currentState: TurnState | null;
  previousState: TurnState | null;
  timeline: TimelineEntry[];
  clarificationState: ClarificationState | null;
  plan: TurnPlan | null;
  rebaseAlert: RebaseAlert | null;
  finalRevision: number | null;
  error: { reason: string; stepId?: string } | null;
  isCompleted: boolean;
};

export const INITIAL_TURN_STREAM_STATE: TurnStreamState = {
  turnId: null,
  currentState: null,
  previousState: null,
  timeline: [],
  clarificationState: null,
  plan: null,
  rebaseAlert: null,
  finalRevision: null,
  error: null,
  isCompleted: false,
};

/**
 * Pure state reducer for turn stream events.
 * Exported for deterministic unit testing without requiring a live WebSocket.
 */
export function processTurnEvent(
  state: TurnStreamState,
  event: TurnStreamEvent,
): TurnStreamState {
  switch (event.type) {
    case "turn.state_changed": {
      const nextState = event.to as TurnState;
      const prevState = event.from as TurnState;
      const nextTimeline = [
        ...state.timeline,
        { from: event.from, to: event.to, timestamp: event.timestamp },
      ];
      return {
        ...state,
        turnId: state.turnId ?? event.turnId,
        currentState: nextState,
        previousState: prevState,
        timeline: nextTimeline,
        // Clear clarificationState once we transition out of needs_input
        clarificationState:
          nextState === "needs_input" ? state.clarificationState : null,
      };
    }

    case "turn.needs_input": {
      return {
        ...state,
        turnId: event.turnId,
        currentState: "needs_input",
        clarificationState: {
          turnId: event.turnId,
          ambiguityReason: event.ambiguityReason,
          questions: event.questions,
        },
      };
    }

    case "turn.plan_ready": {
      const steps: StepPlanItem[] = event.steps.map((step, idx) => ({
        stepIndex: idx,
        stepId: step.stepId,
        goal: step.goal,
        status: "pending",
        attempt: 0,
        activeModel: null,
        gates: { 1: null, 2: null, 3: null },
        history: [],
      }));

      return {
        ...state,
        turnId: event.turnId,
        plan: {
          sceneSummary: event.sceneSummary,
          totalSteps: event.totalSteps,
          steps,
        },
      };
    }

    case "turn.step_started": {
      if (!state.plan) return state;

      const updatedSteps = state.plan.steps.map((step) => {
        if (step.stepIndex !== event.stepIndex && step.stepId !== event.stepId) {
          return step;
        }

        // If this is a new attempt for this step, archive the previous attempt in history
        const nextHistory = [...step.history];
        if (
          step.attempt > 0 &&
          step.attempt !== event.attempt &&
          !nextHistory.some((h) => h.attempt === step.attempt)
        ) {
          nextHistory.push({
            attempt: step.attempt,
            model: step.activeModel,
            gates: { ...step.gates },
          });
        }

        return {
          ...step,
          status: "active" as const,
          attempt: event.attempt,
          activeModel: event.model,
          // Reset gate badges for the new attempt
          gates:
            step.attempt !== event.attempt
              ? { 1: null, 2: null, 3: null }
              : step.gates,
          history: nextHistory,
        };
      });

      return {
        ...state,
        turnId: event.turnId,
        plan: {
          ...state.plan,
          steps: updatedSteps,
        },
      };
    }

    case "turn.gate_result": {
      if (!state.plan) return state;

      const updatedSteps = state.plan.steps.map((step) => {
        if (step.stepId !== event.stepId) return step;

        const gateEval: GateEvaluation = {
          passed: event.passed,
          ...(event.diagnostics !== undefined ? { diagnostics: event.diagnostics } : {}),
        };

        const nextGates = {
          ...step.gates,
          [event.gate]: gateEval,
        };

        // Also record this gate result into the current attempt history
        const nextHistory = [...step.history];
        const existingHistoryIdx = nextHistory.findIndex(
          (h) => h.attempt === event.attempt,
        );

        if (existingHistoryIdx >= 0) {
          const currentEntry = nextHistory[existingHistoryIdx];
          if (currentEntry) {
            nextHistory[existingHistoryIdx] = {
              ...currentEntry,
              gates: {
                ...currentEntry.gates,
                [event.gate]: gateEval,
              },
            };
          }
        } else {
          nextHistory.push({
            attempt: event.attempt,
            model: step.activeModel,
            gates: {
              1: event.gate === 1 ? gateEval : null,
              2: event.gate === 2 ? gateEval : null,
              3: event.gate === 3 ? gateEval : null,
            },
          });
        }

        return {
          ...step,
          gates: nextGates,
          history: nextHistory,
        };
      });

      return {
        ...state,
        turnId: event.turnId,
        plan: {
          ...state.plan,
          steps: updatedSteps,
        },
      };
    }

    case "turn.step_committed": {
      if (!state.plan) return state;

      const updatedSteps = state.plan.steps.map((step) => {
        if (step.stepIndex !== event.stepIndex && step.stepId !== event.stepId) {
          return step;
        }
        return {
          ...step,
          status: "committed" as const,
        };
      });

      return {
        ...state,
        turnId: event.turnId,
        plan: {
          ...state.plan,
          steps: updatedSteps,
        },
      };
    }

    case "turn.stale_rebase": {
      return {
        ...state,
        turnId: event.turnId,
        currentState: "stale",
        rebaseAlert: {
          turnId: event.turnId,
          expectedRevision: event.expectedRevision,
          actualRevision: event.actualRevision,
          rebaseAttempt: event.rebaseAttempt,
        },
      };
    }

    case "turn.completed": {
      return {
        ...state,
        turnId: event.turnId,
        currentState: "completed",
        isCompleted: true,
        finalRevision: event.finalRevision,
        rebaseAlert: null,
      };
    }

    case "turn.failed": {
      const updatedSteps = state.plan?.steps.map((step) => {
        if (event.stepId && step.stepId === event.stepId) {
          return { ...step, status: "failed" as const };
        }
        return step;
      });

      return {
        ...state,
        turnId: event.turnId,
        currentState: "failed",
        error: {
          reason: event.reason,
          ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
        },
        plan: state.plan
          ? {
              ...state.plan,
              steps: updatedSteps ?? state.plan.steps,
            }
          : null,
      };
    }

    default:
      return state;
  }
}

export type TurnStreamOptions = {
  sessionId?: string;
  baseUrl?: string;
  createSocket?: CreateSocket;
  onStepCommitted?: (delta: {
    turnId: string;
    stepIndex: number;
    stepId: string;
    newRevision: number;
    sceneDelta: unknown;
  }) => void;
  onTurnCompleted?: (turnId: string, finalRevision: number) => void;
  onNeedsInput?: (clarification: ClarificationState) => void;
  onTurnFailed?: (error: { reason: string; stepId?: string }) => void;
};

const DEFAULT_BASE_URL =
  process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:3001";

export function useTurnStream(options: TurnStreamOptions = {}) {
  const { sessionId, baseUrl = DEFAULT_BASE_URL } = options;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  const [state, setState] = useState<TurnStreamState>(INITIAL_TURN_STREAM_STATE);

  const onStepCommittedRef = useRef(options.onStepCommitted);
  onStepCommittedRef.current = options.onStepCommitted;

  const onTurnCompletedRef = useRef(options.onTurnCompleted);
  onTurnCompletedRef.current = options.onTurnCompleted;

  const onNeedsInputRef = useRef(options.onNeedsInput);
  onNeedsInputRef.current = options.onNeedsInput;

  const onTurnFailedRef = useRef(options.onTurnFailed);
  onTurnFailedRef.current = options.onTurnFailed;

  const dispatchEvent = useCallback((event: TurnStreamEvent) => {
    setState((prev) => {
      const next = processTurnEvent(prev, event);
      return next;
    });

    if (event.type === "turn.step_committed") {
      onStepCommittedRef.current?.({
        turnId: event.turnId,
        stepIndex: event.stepIndex,
        stepId: event.stepId,
        newRevision: event.newRevision,
        sceneDelta: event.sceneDelta,
      });
    } else if (event.type === "turn.needs_input") {
      onNeedsInputRef.current?.({
        turnId: event.turnId,
        ambiguityReason: event.ambiguityReason,
        questions: event.questions,
      });
    } else if (event.type === "turn.completed") {
      onTurnCompletedRef.current?.(event.turnId, event.finalRevision);
    } else if (event.type === "turn.failed") {
      onTurnFailedRef.current?.({
        reason: event.reason,
        ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
      });
    }
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_TURN_STREAM_STATE);
  }, []);

  const createSocketRef = useRef(createSocket);
  createSocketRef.current = createSocket;

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    let socket: StreamSocket | undefined;
    let abandoned = false;

    try {
      const url = `${baseUrl}/ws?sessionId=${encodeURIComponent(sessionId)}&seq=0`;
      const current = createSocketRef.current(url);
      socket = current;

      current.addEventListener("message", (raw) => {
        if (abandoned) return;
        const data = (raw as MessageEvent<unknown>).data;
        if (typeof data !== "string") return;

        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }

        const parsed = ServerFrameSchema.safeParse(json);
        if (!parsed.success) return;

        const frame: ServerFrame = parsed.data;

        if (frame.type === "ping") {
          current.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (frame.type.startsWith("turn.")) {
          dispatchEvent(frame as TurnStreamEvent);
        }
      });
    } catch {
      // Ignored for environments without WebSocket support
    }

    return () => {
      abandoned = true;
      socket?.close();
    };
  }, [sessionId, baseUrl, dispatchEvent]);

  return {
    ...state,
    reset,
    dispatchEvent,
  };
}
