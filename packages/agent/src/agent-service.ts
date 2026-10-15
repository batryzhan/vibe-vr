/**
 * Driving the model through one turn.
 *
 * A turn is not one request. The model asks for tools, reads what they returned, and asks
 * again; the loop here is what turns that exchange into a single unit of work with one
 * exactly one terminal event at the end. The runtime emits `turn.started` when its workspace is
 * ready, before calling the agent.
 *
 * Three properties are worth more than the rest of this file.
 *
 * **A round trip's tool results go back together.** A single assistant message can carry
 * several tool calls, and answering them in separate user messages is accepted by the API
 * while quietly teaching the model to stop asking for tools in parallel. So the batch is
 * executed, then every result is appended in one user message — failures included, because
 * a tool call without its answering result is rejected outright.
 *
 * **The turn ends once.** Every branch below either emits `turn.completed` or emits
 * `turn.failed`, never both and never neither. Anything replaying a session sees an open
 * turn for exactly as long as the turn was open.
 *
 * **Nothing here is persisted, committed, or torn down.** Events leave through `onEvent`
 * without a `seq`; the commit sha in `turn.completed` comes from a caller-supplied hook.
 * The caller that owns those things is the runtime — see `docs/PLAN.md` §0.
 */

import type { SceneHead } from "@vibe-vr/scene-spec/fold";
import type { NapEvent, NapEventOf, TurnFailureReason } from "@vibe-vr/shared/events";
import type { AgentService, AgentTurnRequest } from "@vibe-vr/shared/ports/agent-service";
import type { PendingEvent } from "@vibe-vr/shared/ports/event-store";
import type {
  LLMContentBlock,
  LLMMessage,
  LLMProvider,
  LLMToolCall,
  LLMTurn,
} from "@vibe-vr/shared/ports/llm-provider";
import { classifySceneRequest } from "./dahl-provider.ts";
import { DeltaStream } from "./delta-stream.ts";
import { buildDemoChair, isDefaultChairRequest } from "./demo-chair.ts";
import { TurnBudget, type TurnBudgetOptions } from "./safety/budget.ts";
import { TOOL_DEFINITIONS } from "./tools/definitions.ts";
import { executeTool, type ToolContext } from "./tools/execute.ts";
import { readSceneHead, summarizeScene } from "./tools/scene.ts";

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];
const CANCELLED = Symbol("cancelled");
const SCENE_TOOL_NAMES = new Set(["get_scene", "propose_scene_patch", "propose_desk"]);

const SCENE_AGENT_PROMPT = `
<3d-scene-editing>
For a request to create or change a 3D scene, treat the scene tools as the source of truth. Do not edit application files or run code to represent a scene change.
- Use the authoritative scene snapshot supplied with the request. If it contains a scene, use its full revision hash as baseHash. If it says no scene exists, create directly without calling get_scene.
- Use propose_scene_patch with a complete valid SceneSpec to create a scene, or a concise patch to edit an existing one.
- For an edit, pass baseHash, ops as a JSON array, and rationale at the top level. Each op is an object: add a material with {op:"add_material",material:{id,name,color,metalness,roughness}} before an add_node that uses its materialId. add_node is {op:"add_node",parentId,node}; never stringify ops or nest the patch.
- For creation, spec must be a JSON object with version, id, seed, units, axes, nodes, materials, and root; spec.id must be a valid UUID, never a display name. Never put a JSON string inside spec.
- SceneSpec v1 uses metres, a right-handed coordinate system, and Y-up. The root and every node need stable ids and valid transforms. Supported procedural geometry is box and cylinder; materials use a hex color, metalness, and roughness.
- Keep geometry within the requested object and the renderer's supported primitives. Do not claim unsupported lighting, textures, or arbitrary mesh/code generation.
- Act as a product designer: a short request delegates the unspecified design choices to you. Choose a cohesive, refined design and build it immediately; ask questions only when essential for an edit. Explicit requests for simplicity, style, dimensions or materials take priority.
- Design silhouette first, then structure, then a few intentional details. For an unspecified chair, use a refined contemporary wood chair: seat about 0.46 m high and 0.46 m wide, four grounded legs, rear supports, a distinct backrest, subtle stretchers and softened seat edges. Add a thin upholstered seat pad only if it suits the chosen style. Ensure all structural parts connect and the object reads clearly from three-quarter view.
- Use 2–4 coordinated materials with realistic roughness: warm wood, a restrained dark structural accent and optionally muted upholstery. Avoid random saturated colors and excessive metalness on wood or fabric. Use supported box bevels of roughly 0.002–0.012 m, never above half the smallest dimension, and tapered cylinders where appropriate.
- Aim for approximately 10–22 purposeful geometry nodes for an ordinary furniture object. Complexity is not quality: retain a clear silhouette, consistent thicknesses, symmetry and appropriate negative space. Avoid unrelated floors, pedestals, text, decorative clutter or whole rooms unless requested.
- For a bare request for a chair, use this complete design brief rather than a six-block placeholder: a beveled walnut seat, four subtly tapered legs, four slim apron rails directly beneath the seat, two rear uprights connected to the rear legs, three spaced narrow back slats and a top rail joining the uprights. Use a lighter warm accent for the slats. Keep the back's negative space visible and the rails attached at their endpoints. Build these parts together in the first proposal. Adapt this brief when the user specifies another chair style or explicitly asks for a minimal model.
- Work efficiently: make one complete scene proposal with all parts and materials. Do not issue a sequence of tiny additions, narrate a lengthy plan or call get_scene when the supplied snapshot is sufficient. Check dimensions, ground contact, material references, hierarchy and bevel limits before submitting. After acceptance, give a short confirmation in the user's language; do not rebuild or embellish an already successful proposal.
- A proposal is not applied until validation succeeds. If the tool rejects it or returns a newer revision, use the latest tool result, fix the reported issue, and retry; then describe the accepted result plainly.
</3d-scene-editing>`;

export type AgentServiceOptions = {
  provider: LLMProvider;
  /** Per-turn ceilings. Defaults come from ./safety/budget.ts. */
  budget?: TurnBudgetOptions;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
  /** Injected for the same reason, for the duration `turn.completed` reports. */
  clock?: () => number;
};

export class NapAgentService implements AgentService {
  readonly #provider: LLMProvider;
  readonly #budget: TurnBudgetOptions;
  readonly #now: () => string;
  readonly #clock: () => number;

  constructor(options: AgentServiceOptions) {
    this.#provider = options.provider;
    this.#budget = options.budget ?? {};
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#clock = options.clock ?? (() => Date.now());
  }

  async runTurn(request: AgentTurnRequest): Promise<void> {
    await new Turn(request, this.#provider, this.#budget, this.#now, this.#clock).run();
  }
}

/**
 * One turn's state, so nothing about a turn lives on the service.
 *
 * Two turns can be in flight at once — the runtime serializes them per session, not per
 * process — and a loop keeping its message list or its budget on `this` of a shared
 * service would let them corrupt each other silently.
 */
class Turn {
  readonly #request: AgentTurnRequest;
  readonly #turn: LLMTurn;
  readonly #budget: TurnBudget;
  readonly #now: () => string;
  readonly #clock: () => number;
  readonly #startedAt: number;
  readonly #messages: LLMMessage[];
  /**
   * This turn's accepted proposals, ahead of the store. Owned here so every
   * tool call in the turn shares one cell; the store catches up through the
   * normal emit path, and the next turn folds from the log like any reader.
   */
  readonly #scene: { head: SceneHead | null } = { head: null };

  constructor(
    request: AgentTurnRequest,
    provider: LLMProvider,
    budget: TurnBudgetOptions,
    now: () => string,
    clock: () => number,
  ) {
    this.#request = request;
    this.#turn = provider.startTurn({
      model: request.model,
      credentials: request.credentials,
    });
    this.#budget = new TurnBudget(budget);
    this.#now = now;
    this.#startedAt = clock();
    this.#clock = clock;
    this.#messages = [...request.context.messages];
  }

  async run(): Promise<void> {
    this.#emit({
      type: "turn.started",
      payload: { source: this.#request.promptSource ?? "user" },
    });

    const firstUserMessage = latestUserMessage(this.#messages);
    const routing = this.#request.referenceImage
      ? { type: "object_creation" as const, needsSpatial: false, needsComposition: false }
      : classifySceneRequest(firstUserMessage);
    const sceneContext =
      routing.type !== "simple_edit" ? await this.#readSceneContext() : undefined;

    if (
      !this.#request.referenceImage &&
      sceneContext?.startsWith("There is no existing") &&
      isDefaultChairRequest(firstUserMessage)
    ) {
      this.#emit({
        type: "system.notice",
        payload: { level: "info", text: "Building a detailed chair from a validated design." },
      });
      const cancelled = await this.#runTools("", [
        {
          id: crypto.randomUUID(),
          name: "propose_scene_patch",
          input: {
            spec: buildDemoChair(),
            rationale:
              "A refined walnut chair with tapered legs, connected apron rails, oak back slats and an olive upholstered seat.",
          },
        },
      ]);
      if (cancelled) return this.#fail("cancelled", "The turn was cancelled.");
      if (this.#scene.head !== null) {
        this.#emit({
          type: "agent.message",
          payload: {
            text: /[а-я]/i.test(firstUserMessage)
              ? "Готово: стул из ореха с коническими ножками, дубовыми планками спинки и мягким оливковым сиденьем. Можно менять размеры, материалы и детали."
              : "Created a walnut chair with tapered legs, oak back slats and an olive upholstered seat. You can refine its dimensions, materials and details.",
          },
        });
        return this.#complete();
      }
    }

    if (routing.type !== "simple_edit") {
      this.#messages.push({
        role: "user",
        content: `Design direction for the request above (respect all explicit user constraints): choose a coherent premium design, real proportions, refined supported bevels and 2–4 coordinated realistic materials. Deliver the complete object in one proposal, including its structural connections and a few purposeful details. Avoid an unfinished blockout. ${
          this.#request.referenceImage
            ? "Use the attached image as the design source. Match the main object's visible silhouette, proportions, part count and colors with supported geometry. Infer hidden surfaces conservatively. Create a 3D approximation, not a flat image plane. Do not substitute a default chair design or add unrelated objects. Respect the user's requested changes to the reference."
            : sceneContext?.startsWith("There is no existing") &&
                /chair|стул/i.test(firstUserMessage)
              ? "For this chair include a beveled walnut seat, four tapered legs, four slim apron rails, two rear uprights, three spaced back slats and one top rail; use a lighter wood accent on the slats. All parts must connect. This is a single furniture object, without a floor or pedestal."
              : "Preserve existing scene objects unless the user requests their replacement."
        }`,
      });
    }

    for (;;) {
      if (this.#cancelled()) return this.#fail("cancelled", "The turn was cancelled.");

      this.#budget.recordStep();
      const stepBudget = this.#budget.check();
      if (!stepBudget.ok) return this.#failWith(stepBudget.failure);

      // One per step, because a step is one stream. Its buffer is flushed the moment the
      // call returns and before any branch below can leave the loop, so the last thought of
      // a turn survives whichever way that turn ended — a refusal and an upstream failure
      // are the two cases where the reasoning is the only account of what happened.
      const thinking = new DeltaStream((text) => {
        if (!this.#cancelled()) this.#emit({ type: "agent.thinking", payload: { text } });
      });

      // The answer's prose, on its own stream. `wrote` is what decides whether the assembled
      // text is emitted afterwards: a model or a route that sends no text deltas would
      // otherwise say nothing at all, and one that sends them would say everything twice.
      let wrote = false;
      const prose = new DeltaStream((text) => {
        if (this.#cancelled()) return;
        wrote = true;
        this.#emit({ type: "agent.message", payload: { text } });
      });

      // The provider receives the signal too, but a proxy or upstream stream can take a while
      // to honour it. Racing here ends our turn immediately, preventing further tool calls or
      // streamed output while the transport tears itself down in the background.
      const completed = await stopAware(
        this.#turn.complete({
          systemPrompt:
            routing.type === "simple_edit"
              ? this.#request.context.systemPrompt
              : `${this.#request.context.systemPrompt}\n\n${SCENE_AGENT_PROMPT}\n\n<authoritative-scene>\n${sceneContext}\n</authoritative-scene>`,
          messages: this.#messages,
          ...(this.#request.referenceImage === undefined
            ? {}
            : { referenceImage: this.#request.referenceImage }),
          tools:
            routing.type === "simple_edit"
              ? TOOL_DEFINITIONS
              : TOOL_DEFINITIONS.filter((tool) => SCENE_TOOL_NAMES.has(tool.name)),
          ...(sceneContext === undefined ? {} : { sceneContext }),
          onActivity: (message) => {
            if (!this.#cancelled()) {
              this.#emit({ type: "system.notice", payload: { level: "info", text: message } });
            }
          },
          onThinkingDelta: (delta) => thinking.push(delta),
          onTextDelta: (delta) => prose.push(delta),
          ...(this.#request.signal === undefined ? {} : { signal: this.#request.signal }),
        }),
        this.#request.signal,
      );

      if (completed === CANCELLED || this.#cancelled()) {
        return this.#fail("cancelled", "The turn was cancelled.");
      }
      const result = completed;

      thinking.flush();
      prose.flush();

      if (result.type === "refusal") {
        return this.#fail("refusal", "The model declined to answer this request.");
      }
      if (result.type === "error") {
        // `retryable` here means the provider *already* retried and the model was still not
        // there — a throttle or an overload, which is a different sentence to the user than
        // something in this system going wrong.
        return this.#fail(result.retryable ? "model_unavailable" : "internal", result.message);
      }

      this.#budget.recordUsage(result.usage);
      const tokenBudget = this.#budget.check();
      if (!tokenBudget.ok) return this.#failWith(tokenBudget.failure);

      // Only when the prose did not already arrive in pieces. The assembled text is the same
      // words the deltas carried, so emitting it as well would print the answer twice.
      if (!wrote && result.text !== "") {
        this.#emit({ type: "agent.message", payload: { text: result.text } });
      }

      if (result.toolCalls.length === 0) return await this.#complete();

      const cancelled = await this.#runTools(result.text, result.toolCalls);
      if (cancelled) return this.#fail("cancelled", "The turn was cancelled.");
    }
  }

  /** Read the same revision the scene tools validate against before specialists run. */
  async #readSceneContext(): Promise<string> {
    const read = this.#request.readSessionEvents;
    if (read === undefined)
      return "Scene history is unavailable; do not invent ids or coordinates.";
    try {
      const head = readSceneHead(await read(this.#request.sessionId));
      return head === null
        ? "There is no existing 3D scene; recommend a layout without inventing existing object ids."
        : summarizeScene(head);
    } catch {
      return "Scene history could not be read; do not invent ids or coordinates.";
    }
  }

  /**
   * Executes a batch of tool calls and appends both halves of the exchange.
   *
   * Returns whether the turn was cancelled part-way. The results collected so far are
   * deliberately *not* sent: the conversation is being abandoned, and a user message
   * answering only some of an assistant message's tool calls is a request the API rejects.
   */
  async #runTools(text: string, calls: readonly LLMToolCall[]): Promise<boolean> {
    const results: LLMContentBlock[] = [];

    for (const call of calls) {
      if (this.#cancelled()) return true;

      const outcome = await executeTool(call, this.#toolContext());
      results.push({
        type: "tool_result",
        toolCallId: call.id,
        content: outcome.output,
        // A failed tool is a result the model reads and works around, never a dropped block.
        isError: !outcome.ok,
      });
    }

    const assistant: LLMContentBlock[] = calls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    }));
    if (text !== "") assistant.unshift({ type: "text", text });

    this.#messages.push({ role: "assistant", content: assistant });
    // Every result in one message: see the note at the top of this file.
    this.#messages.push({ role: "user", content: results });

    return false;
  }

  async #complete(): Promise<void> {
    // Awaited before the event rather than after, so a turn is never reported done while
    // the work it did is still uncommitted.
    const finalized = await this.#request.finalize?.();

    this.#emit({
      type: "turn.completed",
      payload: {
        usage: this.#turn.usage(),
        durationMs: this.#clock() - this.#startedAt,
        commitSha: finalized?.commitSha ?? null,
      },
    });
  }

  #cancelled(): boolean {
    return this.#request.signal?.aborted === true;
  }

  #fail(reason: TurnFailureReason, message: string): void {
    this.#failWith({ reason, message });
  }

  #failWith(failure: Payload<"turn.failed">): void {
    this.#emit({ type: "turn.failed", payload: failure });
  }

  #toolContext(): ToolContext {
    return {
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sandboxId: this.#request.sandboxId,
      sandbox: this.#request.sandbox,
      emit: this.#request.onEvent,
      ...(this.#request.readSessionEvents === undefined
        ? {}
        : { readSessionEvents: this.#request.readSessionEvents }),
      sceneState: this.#scene,
      now: this.#now,
    };
  }

  /**
   * Written as a generic over the discriminated union so `type` and `payload` stay
   * correlated — the pair is the whole contract.
   */
  #emit<T extends NapEvent["type"]>(event: { type: T; payload: Payload<T> }): void {
    this.#request.onEvent({
      ...event,
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      createdAt: this.#now(),
    } as PendingEvent);
  }
}

function latestUserMessage(messages: readonly LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  }
  return "";
}

/** Resolves promptly on abort even if an upstream streaming request is slow to settle. */
function stopAware<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof CANCELLED> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.resolve(CANCELLED);

  return new Promise((resolve, reject) => {
    const stopped = () => resolve(CANCELLED);
    signal.addEventListener("abort", stopped, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped));
  });
}
