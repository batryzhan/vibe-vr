import type { ModelCredentials } from "@vibe-vr/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import {
  availableModels,
  createOpenRouterCaller,
  extractCleanJson,
  getModelConfigForRole,
  isFree,
  resolveTurnAccess,
  type TurnAccessRequest,
} from "./model-access.ts";

/** The shape of a real allowlist: cheap paid, expensive paid, and free. */
const ALLOWED = [
  "openai/gpt-5.6-luna",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "openai/gpt-oss-20b:free",
] as const;

const OPENROUTER: ModelCredentials = { platform: "openrouter", apiKey: "sk-or-theirs" };
const ANTHROPIC: ModelCredentials = { platform: "anthropic", apiKey: "sk-ant-theirs" };

function ask(overrides: Partial<TurnAccessRequest> = {}): TurnAccessRequest {
  return {
    requested: undefined,
    key: null,
    allowed: ALLOWED,
    freeModel: "openai/gpt-5.6-luna",
    defaultModel: "openai/gpt-5.6-luna",
    ...overrides,
  };
}

describe("isFree", () => {
  it("reads OpenRouter's convention and nothing else", () => {
    expect(isFree("openai/gpt-oss-20b:free")).toBe(true);
    expect(isFree("anthropic/claude-opus-5")).toBe(false);
    // Not a suffix, so not free. A substring match here would make ":free-tier-preview" free.
    expect(isFree("vendor/free-model")).toBe(false);
  });
});

describe("with no key of their own", () => {
  it("runs the free model when nothing is named", () => {
    expect(resolveTurnAccess(ask())).toEqual({ ok: true, model: "openai/gpt-5.6-luna" });
  });

  it("never attaches credentials, so the deployment's own account pays", () => {
    const access = resolveTurnAccess(ask());

    expect(access.ok === true && access.credentials).toBeUndefined();
  });

  it("allows a free model that was named explicitly", () => {
    expect(resolveTurnAccess(ask({ requested: "openai/gpt-oss-20b:free" }))).toEqual({
      ok: true,
      model: "openai/gpt-oss-20b:free",
    });
  });

  it("allows the deployment's free model even though it is not :free-suffixed", () => {
    // The freeModel is what the deployment chose to give demo visitors. That choice is not
    // always a :free-suffixed model — here it is Luna, which the deployment pays for.
    expect(resolveTurnAccess(ask({ requested: "openai/gpt-5.6-luna" }))).toEqual({
      ok: true,
      model: "openai/gpt-5.6-luna",
    });
  });

  it("allows every configured model when the deployment has a shared provider key", () => {
    for (const model of ALLOWED) {
      expect(resolveTurnAccess(ask({ requested: model, serverFundedModels: true }))).toEqual({
        ok: true,
        model,
      });
    }
  });

  it("refuses a paid model that is not the deployment's chosen free model", () => {
    // The rule this whole module exists for. Each of these is on the allowlist, so nothing
    // else in the request pipeline would stop it.
    for (const model of ["anthropic/claude-opus-5"]) {
      expect(resolveTurnAccess(ask({ requested: model }))).toMatchObject({
        ok: false,
        code: "byok_required",
      });
    }
  });

  it("says a model is unknown rather than asking for a key, when it is unknown", () => {
    // A typo must not send somebody off to fetch a credential that would not have helped.
    expect(resolveTurnAccess(ask({ requested: "openai/not-a-model" }))).toMatchObject({
      code: "model_not_allowed",
    });
  });
});

describe("with an OpenRouter key", () => {
  it("runs the deployment's default when nothing is named", () => {
    expect(resolveTurnAccess(ask({ key: OPENROUTER }))).toEqual({
      ok: true,
      model: "openai/gpt-5.6-luna",
      credentials: OPENROUTER,
    });
  });

  it("reaches every model on the allowlist, billed to that key", () => {
    for (const model of ALLOWED) {
      expect(resolveTurnAccess(ask({ key: OPENROUTER, requested: model }))).toEqual({
        ok: true,
        model,
        credentials: OPENROUTER,
      });
    }
  });

  it("still refuses a model that is not on the allowlist", () => {
    // A key of their own is not permission to name arbitrary models: the allowlist is also
    // what keeps a turn on a model that cannot call tools, and every such turn fails.
    expect(resolveTurnAccess(ask({ key: OPENROUTER, requested: "vendor/anything" }))).toMatchObject(
      { code: "model_not_allowed" },
    );
  });
});

describe("with an Anthropic key", () => {
  it("runs a Claude model when nothing is named, not the OpenRouter-shaped default", () => {
    // `VIBE_VR_MODEL` is namespaced for OpenRouter and unreachable at Anthropic's own API, so
    // falling through to it would make "just send a message" fail for every Anthropic key.
    expect(resolveTurnAccess(ask({ key: ANTHROPIC }))).toEqual({
      ok: true,
      model: "anthropic/claude-sonnet-5",
      credentials: ANTHROPIC,
    });
  });

  it("reaches the Claude models", () => {
    expect(
      resolveTurnAccess(ask({ key: ANTHROPIC, requested: "anthropic/claude-opus-5" })),
    ).toEqual({ ok: true, model: "anthropic/claude-opus-5", credentials: ANTHROPIC });
  });

  it("refuses another vendor's model, naming the actual problem", () => {
    // Sent anyway, this is a 401 from Anthropic — a message about credentials for what is
    // really a routing mistake.
    const refusal = resolveTurnAccess(ask({ key: ANTHROPIC, requested: "openai/gpt-5.6-luna" }));

    expect(refusal).toMatchObject({ ok: false, code: "model_not_allowed" });
    expect(refusal.ok === false && refusal.message).toContain("Anthropic key");
  });

  it("refuses even a free model from another vendor", () => {
    expect(
      resolveTurnAccess(ask({ key: ANTHROPIC, requested: "openai/gpt-oss-20b:free" })),
    ).toMatchObject({ code: "model_not_allowed" });
  });
});

describe("availableModels", () => {
  const FREE_MODEL = "openai/gpt-5.6-luna";

  it("offers the freeModel and any :free-suffixed models to somebody with no key", () => {
    // The freeModel is always offered, regardless of suffix. Any additional :free-suffixed
    // models are offered too, since those cost the deployment nothing.
    expect(availableModels(ALLOWED, null, FREE_MODEL)).toEqual([
      "openai/gpt-5.6-luna",
      "openai/gpt-oss-20b:free",
    ]);
  });

  it("offers everything to an OpenRouter key", () => {
    expect(availableModels(ALLOWED, OPENROUTER)).toEqual([...ALLOWED]);
  });

  it("offers every configured model to keyless callers when the deployment funds them", () => {
    expect(availableModels(ALLOWED, null, FREE_MODEL, true)).toEqual([...ALLOWED]);
  });

  it("offers the Claude models to an Anthropic key", () => {
    expect(availableModels(ALLOWED, ANTHROPIC)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
    ]);
  });

  it("agrees with what resolveTurnAccess actually allows", () => {
    // The picker is built from the first and the turn is enforced by the second. Two lists
    // that drift produce a menu offering models every turn is then refused for naming, which
    // is the exact failure the models route's own comment warns about.
    for (const key of [null, OPENROUTER, ANTHROPIC]) {
      for (const model of ALLOWED) {
        const offered = availableModels(ALLOWED, key, FREE_MODEL).includes(model);
        const allowed = resolveTurnAccess(ask({ key, requested: model })).ok;
        expect(offered).toBe(allowed);
      }
    }
  });
});

describe("getModelConfigForRole", () => {
  const fakeEnv = {
    ORCHESTRATOR_VISION_MODEL: "openai/gpt-5.6-luna",
    SCENE_PLANNER_MODEL: "deepseek/deepseek-r1",
    GEOMETRY_BUILDER_MODEL: "qwen/qwen-2.5-coder-32b-instruct",
    FALLBACK_BUILDER_MODEL: "openai/gpt-5.6-luna",
  } as unknown as Env;

  it("returns correct config for intake_vision", () => {
    expect(getModelConfigForRole("intake_vision", fakeEnv)).toEqual({
      model: "openai/gpt-5.6-luna",
      temperature: 0.2,
      maxTokens: 1500,
    });
  });

  it("returns correct config for scene_planner", () => {
    expect(getModelConfigForRole("scene_planner", fakeEnv)).toEqual({
      model: "deepseek/deepseek-r1",
      temperature: 0.6,
      maxTokens: 4096,
    });
  });

  it("returns correct config for geometry_builder", () => {
    expect(getModelConfigForRole("geometry_builder", fakeEnv)).toEqual({
      model: "qwen/qwen-2.5-coder-32b-instruct",
      temperature: 0.1,
      maxTokens: 2500,
      responseFormat: { type: "json_object" },
    });
  });

  it("returns correct config for geometry_fallback", () => {
    expect(getModelConfigForRole("geometry_fallback", fakeEnv)).toEqual({
      model: "openai/gpt-5.6-luna",
      temperature: 0.1,
      maxTokens: 2500,
      responseFormat: { type: "json_object" },
    });
  });

  it("returns correct config for vision_validator", () => {
    expect(getModelConfigForRole("vision_validator", fakeEnv)).toEqual({
      model: "openai/gpt-5.6-luna",
      temperature: 0.0,
      maxTokens: 1024,
      responseFormat: { type: "json_object" },
    });
  });
});

describe("extractCleanJson", () => {
  it("leaves clean JSON untouched", () => {
    const raw = '{"hello": "world"}';
    expect(extractCleanJson(raw)).toBe(raw);
  });

  it("trims whitespace", () => {
    const raw = '   \n\t {"hello": "world"}  \n ';
    expect(extractCleanJson(raw)).toBe('{"hello": "world"}');
  });

  it("strips DeepSeek-R1 <think> blocks", () => {
    const raw = `<think>
I need to plan the desk and chairs.
Let's make sure the table is 1.5m wide.
</think>
{"status": "ready", "sceneSummary": "office desk"}
`;
    expect(extractCleanJson(raw)).toBe('{"status": "ready", "sceneSummary": "office desk"}');
  });

  it("strips markdown json fences", () => {
    const raw = `\`\`\`json
{
  "stepId": "step_1",
  "operations": []
}
\`\`\``;
    expect(extractCleanJson(raw)).toBe('{\n  "stepId": "step_1",\n  "operations": []\n}');
  });

  it("strips bare markdown fences", () => {
    const raw = `\`\`\`
{"valid": true}
\`\`\``;
    expect(extractCleanJson(raw)).toBe('{"valid": true}');
  });

  it("handles both <think> blocks and code fences together", () => {
    const raw = `<think>
Thinking about operations...
</think>
\`\`\`json
{"stepId": "test"}
\`\`\``;
    expect(extractCleanJson(raw)).toBe('{"stepId": "test"}');
  });
});

describe("createOpenRouterCaller", () => {
  it("formats request correctly and extracts content from response", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> = {};
    let requestedBody: any = null;

    globalThis.fetch = (async (url: any, init: any) => {
      requestedUrl = String(url);
      requestedHeaders = init.headers;
      requestedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"status": "ok"}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    try {
      const caller = createOpenRouterCaller({
        apiKey: "sk-or-test-key",
        baseUrl: "https://custom.openrouter.ai/api/v1",
      });

      const res = await caller({
        config: {
          model: "deepseek/deepseek-r1",
          temperature: 0.6,
          maxTokens: 4096,
        },
        systemPrompt: "You are the Scene Planner",
        userContent: "Build a desk",
      });

      expect(res).toBe('{"status": "ok"}');
      expect(requestedUrl).toBe("https://custom.openrouter.ai/api/v1/chat/completions");
      expect(requestedHeaders["Authorization"]).toBe("Bearer sk-or-test-key");
      expect(requestedBody.model).toBe("deepseek/deepseek-r1");
      expect(requestedBody.temperature).toBe(0.6);
      expect(requestedBody.max_tokens).toBe(4096);
      expect(requestedBody.messages).toEqual([
        { role: "system", content: "You are the Scene Planner" },
        { role: "user", content: "Build a desk" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws descriptive error when API answers non-200", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("Insufficient balance", { status: 402 });
    }) as any;

    try {
      const caller = createOpenRouterCaller({ apiKey: "sk-or-key" });
      await expect(
        caller({
          config: { model: "test", temperature: 0, maxTokens: 100 },
          systemPrompt: "sys",
          userContent: "usr",
        }),
      ).rejects.toThrow("OpenRouter API error 402: Insufficient balance");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
