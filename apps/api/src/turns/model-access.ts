/**
 * Which model a turn may run on, and whose account pays for it.
 *
 * **This is the only thing standing between a stranger with an account and this deployment's
 * bill.** `VIBE_VR_ALLOWED_MODELS` says which models exist; this says which of them *this caller*
 * may reach, and the difference is money. Before it existed, every signed-in person could name
 * `anthropic/claude-opus-5` and the deployment paid for it.
 *
 * Normally the deployment key buys the explicit freeModel and any `:free` models. A
 * server-funded provider can widen that set to its configured allowlist; this is how Dahl
 * offers its included models without asking each person for another key. Personal-key
 * deployments keep the narrower rule.
 *
 * A pure function taking everything it needs, so the whole policy is a table in a test rather
 * than a set of branches spread across a route handler. That matters here more than usual —
 * "which of these eleven combinations lets somebody spend my money?" is a question that has to
 * be answerable by reading, not by tracing.
 *
 * It returns the *resolved* model rather than validating one in place. A caller that has to
 * remember to apply a default afterwards is a caller that will one day forget, and forgetting
 * means falling through to `VIBE_VR_MODEL`, which is a paid model.
 */

import type { ModelCredentials } from "@vibe-vr/shared/ports/llm-provider";
import type { Env } from "../env.ts";

// ── Multi-model pipeline routing ─────────────────────────────────────────────
//
// The turn pipeline routes each stage to a different model via OpenRouter.
// `getModelConfigForRole` resolves environment variables to concrete model
// configurations, and `extractCleanJson` normalises model output before parsing.
//
// These additions are orthogonal to the BYOK access control below: the access
// control decides *whose account* pays and *which catalogue* is reachable;
// the pipeline routing decides which model handles each stage of the turn.

/**
 * The five pipeline roles a model call can serve.
 *
 * Named for what the call *does*, not what model runs it, because a deployment
 * can swap any of the three models without touching the pipeline logic.
 */
export type ModelRole =
  | "intake_vision"
  | "scene_planner"
  | "geometry_builder"
  | "geometry_fallback"
  | "vision_validator";

/**
 * The configuration passed to the OpenRouter API for a model call.
 *
 * `responseFormat` is set only for roles that must return JSON — the builder
 * and the vision validator. The planner (DeepSeek-R1) wraps its output in
 * `<think>` blocks that are stripped by `extractCleanJson` instead.
 */
export type ModelConfig = {
  model: string;
  temperature: number;
  maxTokens: number;
  responseFormat?: { type: "json_object" };
};

/**
 * Resolves a pipeline role to its model configuration using environment variables.
 *
 * A pure function of `role` and `env`, so it is testable without a running process
 * and cannot drift from whatever the environment says at boot.
 */
export function getModelConfigForRole(role: ModelRole, env: Env): ModelConfig {
  switch (role) {
    case "intake_vision":
      return {
        model: env.ORCHESTRATOR_VISION_MODEL,
        temperature: 0.2,
        maxTokens: 1500,
      };
    case "scene_planner":
      return {
        model: env.SCENE_PLANNER_MODEL,
        temperature: 0.6,
        maxTokens: 4096,
      };
    case "geometry_builder":
      return {
        model: env.GEOMETRY_BUILDER_MODEL,
        temperature: 0.1,
        maxTokens: 2500,
        responseFormat: { type: "json_object" },
      };
    case "geometry_fallback":
      return {
        model: env.FALLBACK_BUILDER_MODEL,
        temperature: 0.1,
        maxTokens: 2500,
        responseFormat: { type: "json_object" },
      };
    case "vision_validator":
      return {
        model: env.ORCHESTRATOR_VISION_MODEL,
        temperature: 0.0,
        maxTokens: 1024,
        responseFormat: { type: "json_object" },
      };
  }
}

/**
 * Strips model-specific wrapping from raw LLM output and returns clean JSON text.
 *
 * Two models in the pipeline wrap their JSON in non-JSON envelopes:
 *
 * - **DeepSeek-R1** emits `<think>…</think>` reasoning blocks before its answer.
 *   These are valuable for debugging but must be removed before `JSON.parse`.
 *
 * - **Qwen 2.5** sometimes wraps JSON in markdown code fences (` ```json … ``` `)
 *   even when `responseFormat` requests raw JSON.
 *
 * This function handles both, in that order, and trims whitespace so the result
 * is ready for `JSON.parse`. It does not parse — the caller decides what schema
 * to validate against — so a model that returns plain JSON passes through unchanged.
 */
export function extractCleanJson(rawText: string): string {
  // 1. Strip DeepSeek-R1 reasoning blocks. The regex is non-greedy and handles
  //    newlines within the block. Multiple blocks are stripped (R1 occasionally
  //    emits more than one).
  let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/g, "");

  // 2. Strip markdown code fences. Handles ```json, ```JSON, and bare ```.
  //    Only the outermost fence pair is stripped — nested fences in string
  //    literals are left intact because the regex is non-greedy.
  cleaned = cleaned.replace(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/g, "$1");

  return cleaned.trim();
}

// ── BYOK access control ──────────────────────────────────────────────────────

/** What is known about the asker: the key they saved, already opened, or nothing. */
export type CallerKey = ModelCredentials | null;

export type TurnAccess =
  | {
      ok: true;
      /** The id to run on, always concrete — never left for a caller to default. */
      model: string;
      /** Absent means this deployment pays — true for freeModel and :free-suffixed models. */
      credentials?: ModelCredentials;
    }
  | { ok: false; code: "byok_required" | "model_not_allowed"; message: string };

export type TurnAccessRequest = {
  /** What the caller asked for, if anything. Absent is the ordinary case. */
  requested: string | undefined;
  key: CallerKey;
  /** The deployment's allowlist — every model that exists here, free and paid. */
  allowed: readonly string[];
  /** What somebody with no key of their own runs on. The deployment pays for these turns. */
  freeModel: string;
  /** What somebody with a key runs on when they name nothing. */
  defaultModel: string;
  /** The deployment has a server-side provider key that funds every model in `allowed`. */
  serverFundedModels?: boolean;
};

/**
 * How a refusal is answered over HTTP, in one place because two routes now answer it.
 *
 * **403 for `byok_required` and 400 for the rest.** Naming a model you are not allowed to *pay
 * for* is a permission answer with something to do about it; naming one that does not exist here
 * is a bad request with nothing a key would fix. The browser reads the code and offers the key
 * form on the first but not the second — so the two routes disagreeing about the status would be
 * the same refusal offering a way out on one page and not the other.
 */
export function refusalStatus(code: Extract<TurnAccess, { ok: false }>["code"]): 400 | 403 {
  return code === "byok_required" ? 403 : 400;
}

/** OpenRouter's convention, and the only thing that marks a model as costing nothing. */
export function isFree(model: string): boolean {
  return model.endsWith(":free");
}

/**
 * Whether a key of this kind can reach this model at all.
 *
 * An Anthropic key is not a smaller OpenRouter key — it reaches Anthropic's catalogue and
 * nothing else, so offering somebody's Anthropic key an OpenAI model produces a 401 from a
 * vendor rather than an answer. Refusing here means the message names the actual problem.
 */
function reachableWith(model: string, platform: ModelCredentials["platform"]): boolean {
  return platform === "openrouter" || model.startsWith("anthropic/");
}

/**
 * Every model this caller may name, in the allowlist's order.
 *
 * For a keyless caller, this includes the deployment's `freeModel` (always, regardless of
 * suffix) and any model that carries the `:free` suffix.
 */
export function availableModels(
  allowed: readonly string[],
  key: CallerKey,
  freeModel?: string,
  serverFundedModels = false,
): string[] {
  if (key === null && serverFundedModels) return [...allowed];
  if (key === null) return allowed.filter((model) => model === freeModel || isFree(model));
  return allowed.filter((model) => reachableWith(model, key.platform));
}

export function resolveTurnAccess(request: TurnAccessRequest): TurnAccess {
  const { requested, key, allowed } = request;

  // Named a model that this deployment does not have at all. Checked before anything about
  // keys, because it is a malformed request rather than a question of who may spend what —
  // and answering "bring a key" to somebody who named a typo would send them off to fetch a
  // credential that will not help.
  if (requested !== undefined && !allowed.includes(requested)) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: `model must be one of: ${allowed.join(", ")}`,
    };
  }

  if (key === null) {
    if (request.serverFundedModels) {
      return { ok: true, model: requested ?? request.freeModel };
    }
    // No key: only the deployment's chosen free model, on the deployment's account.
    // `freeModel` is the deployment's explicit choice and is always reachable, regardless of
    // whether it carries the `:free` suffix — the suffix is OpenRouter's convention, but the
    // deployment may intentionally pay for a non-free model as its demo offering.
    if (requested === undefined) return { ok: true, model: request.freeModel };
    if (requested === request.freeModel || isFree(requested)) return { ok: true, model: requested };

    return {
      ok: false,
      code: "byok_required",
      message: "That model needs your own API key. Add one, or pick a free model.",
    };
  }

  const model = requested ?? defaultFor(request, key);

  if (!reachableWith(model, key.platform)) {
    return {
      ok: false,
      code: "model_not_allowed",
      message: "An Anthropic key can only run the Claude models. Pick one of those.",
    };
  }

  // A free model still runs on their key rather than ours. It costs them nothing either way,
  // and the alternative is a rule where which account pays depends on which model was picked —
  // which is the kind of thing that is true until somebody reorders a condition.
  return { ok: true, model, credentials: key };
}

/**
 * What to run when somebody with a key names no model.
 *
 * `defaultModel` is `VIBE_VR_MODEL`, which is namespaced for OpenRouter — so it is the wrong
 * answer for an Anthropic key, which cannot reach it. Falling back to the first Claude model
 * in the allowlist keeps "just send a message" working for both kinds of key, which is the
 * only thing this needs to do.
 */
function defaultFor(request: TurnAccessRequest, key: ModelCredentials): string {
  if (key.platform === "openrouter") return request.defaultModel;
  return (
    request.allowed.find((model) => model.startsWith("anthropic/")) ??
    // An allowlist with no Claude model in it and an Anthropic key is a configuration nobody
    // has, and the refusal above is a better answer than a guess.
    request.defaultModel
  );
}

import type { LlmCaller } from "./scene-planner.ts";

/**
 * Creates an LlmCaller function targeting the OpenRouter chat completions endpoint.
 */
export function createOpenRouterCaller(options: {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): LlmCaller {
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  return async ({ config, systemPrompt, userContent }) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        ...(config.responseFormat ? { response_format: config.responseFormat } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter API error ${res.status}: ${errText}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (content === undefined || content === null) {
      throw new Error("OpenRouter API returned no content in response");
    }
    return content;
  };
}
