import type { LLMToolDefinition } from "@vibe-vr/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { classifySceneRequest, DahlChatClient, DahlProvider } from "./dahl-provider.ts";
import { SCENE_ORCHESTRATION_EVAL_CASES } from "./scene-eval/orchestration-cases.ts";

const tool: LLMToolDefinition = {
  name: "propose_scene_patch",
  description: "Propose validated scene changes.",
  inputSchema: {
    type: "object",
    properties: { rationale: { type: "string" } },
    required: ["rationale"],
  },
};

function completion(message: Record<string, unknown>, model = "zai-org/GLM-5.3-Flash") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model,
      choices: [{ index: 0, finish_reason: "stop", message }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("classifySceneRequest", () => {
  it.each([
    ["Make the cube red.", "simple_edit", false, false],
    ["Create a wooden chair.", "object_creation", false, false],
    ["Add a red sports car near the biggest house.", "spatial_edit", true, true],
    ["Create a Japanese village surrounded by mountains.", "complex_generation", true, true],
    ["Make the scene cinematic with warm light.", "visual_edit", false, true],
    ["Make the mountains taller and add a lake behind the village.", "multi_step", true, false],
    ["Create a dark forest, then add a cabin near the river.", "complex_generation", true, true],
    ["Create a dashboard to manage project tasks.", "simple_edit", false, false],
    ["Add a market in the center of the village.", "spatial_edit", true, false],
    ["Add a forest-green cushion centered on the chair seat.", "spatial_edit", true, true],
    ["Make the sky darker.", "visual_edit", false, true],
  ] as const)("routes %s", (prompt, type, needsSpatial, needsComposition) => {
    expect(classifySceneRequest(prompt)).toEqual({ type, needsSpatial, needsComposition });
  });

  it("passes the 28-prompt offline orchestration evaluation set", () => {
    expect(SCENE_ORCHESTRATION_EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    for (const testCase of SCENE_ORCHESTRATION_EVAL_CASES) {
      expect(classifySceneRequest(testCase.prompt), testCase.id).toEqual({
        type: testCase.expected,
        needsSpatial: testCase.spatial,
        needsComposition: testCase.composition,
      });
    }
  });
});

describe("DahlChatClient", () => {
  it("uses the Dahl chat-completions endpoint, maps tools, and parses tool calls and usage", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    let requestedBody: Record<string, unknown> = {};
    const client = new DahlChatClient({
      apiKey: "dahl-test-secret",
      baseUrl: "https://inference.dahl.global/v1/",
      fetcher: async (url, init) => {
        requestedUrl = String(url);
        requestedHeaders = new Headers(init?.headers);
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return completion({
          content: null,
          tool_calls: [
            {
              id: "call-1",
              function: { name: "propose_scene_patch", arguments: '{"rationale":"add chair"}' },
            },
          ],
        });
      },
    });

    const result = await client.complete({
      model: "zai-org/GLM-5.3-Flash",
      systemPrompt: "system",
      messages: [{ role: "user", content: "Create a chair." }],
      tools: [tool],
      correlationId: "00000000-0000-4000-8000-000000000001",
      maxTokens: 1000,
    });

    expect(requestedUrl).toBe("https://inference.dahl.global/v1/chat/completions");
    expect(requestedHeaders.get("authorization")).toBe("Bearer dahl-test-secret");
    expect(requestedHeaders.get("x-correlation-id")).toBe("00000000-0000-4000-8000-000000000001");
    expect(requestedHeaders.get("x-request-id")).toBeTruthy();
    expect(requestedBody.model).toBe("zai-org/GLM-5.3-Flash");
    expect(requestedBody.tools).toEqual([
      {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      text: "",
      toolCalls: [{ id: "call-1", name: "propose_scene_patch", input: { rationale: "add chair" } }],
      usage: { inputTokens: 12, outputTokens: 7 },
    });
  });

  it("falls back to strict JSON tool calls when the route rejects function calling", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new DahlChatClient({
      apiKey: "dahl-test-secret",
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (bodies.length === 1)
          return new Response(
            JSON.stringify({ error: { message: "tool calling is unsupported for this model" } }),
            { status: 400 },
          );
        return completion({
          content:
            '{"tool_calls":[{"name":"propose_scene_patch","arguments":{"rationale":"safe fallback"}}]}',
        });
      },
    });

    const result = await client.complete({
      model: "zai-org/GLM-5.3-Flash",
      systemPrompt: "system",
      messages: [{ role: "user", content: "edit" }],
      tools: [tool],
      correlationId: crypto.randomUUID(),
      maxTokens: 500,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.tools).toBeDefined();
    expect(bodies[1]?.tools).toBeUndefined();
    expect(result.ok && result.toolCalls[0]?.input).toEqual({ rationale: "safe fallback" });
  });

  it("retries throttling with bounded backoff and refuses malformed tool JSON", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new DahlChatClient({
      apiKey: "dahl-test-secret",
      maxAttempts: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetcher: async () => {
        calls++;
        if (calls === 1) return new Response("busy", { status: 429 });
        return completion({
          content: null,
          tool_calls: [
            { id: "bad", function: { name: "propose_scene_patch", arguments: "not-json" } },
          ],
        });
      },
    });
    const result = await client.complete({
      model: "zai-org/GLM-5.3-Flash",
      systemPrompt: "system",
      messages: [],
      tools: [tool],
      correlationId: crypto.randomUUID(),
      maxTokens: 500,
    });
    expect(calls).toBe(2);
    expect(delays).toEqual([500]);
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      message: expect.stringContaining("invalid JSON"),
    });
  });

  it("honors the provider's Retry-After header before retrying", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new DahlChatClient({
      apiKey: "dahl-test-secret",
      maxAttempts: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetcher: async () => {
        calls++;
        if (calls === 1)
          return new Response("capacity", { status: 429, headers: { "retry-after": "10" } });
        return completion({ content: "ready" });
      },
    });

    const result = await client.complete({
      model: "zai-org/GLM-5.3-Flash",
      systemPrompt: "system",
      messages: [],
      correlationId: crypto.randomUUID(),
      maxTokens: 100,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([10_000]);
  });
});

describe("DahlProvider orchestration", () => {
  it.each(["capacity", "invalid tool JSON"] as const)(
    "uses the configured MiniMax fallback after primary %s",
    async (failure) => {
      const models: string[] = [];
      const activities: string[] = [];
      const provider = new DahlProvider({
        apiKey: "dahl-test-secret",
        maxAttempts: 1,
        fetcher: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { model: string };
          models.push(body.model);
          if (body.model === "zai-org/GLM-5.3-Flash") {
            return failure === "capacity"
              ? new Response(
                  JSON.stringify({ error: { message: "model at concurrency capacity" } }),
                  { status: 429 },
                )
              : completion(
                  {
                    content: null,
                    tool_calls: [
                      { id: "bad", function: { name: tool.name, arguments: "not-json" } },
                    ],
                  },
                  body.model,
                );
          }
          return completion({ content: "The validated scene proposal is ready." }, body.model);
        },
      });

      const result = await provider.startTurn().complete({
        systemPrompt: "system",
        messages: [{ role: "user", content: "Create a wooden chair." }],
        tools: [tool],
        onActivity: (message) => activities.push(message),
      });

      expect(result.type).toBe("message");
      expect(models).toEqual(["zai-org/GLM-5.3-Flash", "MiniMaxAI/MiniMax-M2.7"]);
      expect(activities.at(-1)).toContain("retrying this request with MiniMaxAI/MiniMax-M2.7");
    },
  );

  it("keeps the selected fallback for the remaining completions in a turn", async () => {
    const models: string[] = [];
    const provider = new DahlProvider({
      apiKey: "dahl-test-secret",
      maxAttempts: 1,
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        models.push(body.model);
        if (body.model === "zai-org/GLM-5.3-Flash") {
          return new Response("capacity", { status: 429 });
        }
        if (models.length === 2) {
          return completion(
            {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  function: { name: tool.name, arguments: '{"rationale":"chair proposal"}' },
                },
              ],
            },
            body.model,
          );
        }
        return completion({ content: "The scene edit is validated." }, body.model);
      },
    });
    const turn = provider.startTurn();
    const first = await turn.complete({
      systemPrompt: "system",
      messages: [{ role: "user", content: "Create a wooden chair." }],
      tools: [tool],
    });
    const second = await turn.complete({
      systemPrompt: "system",
      messages: [
        { role: "user", content: "Create a wooden chair." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: tool.name,
              input: { rationale: "chair proposal" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              content: "Scene created.",
              isError: false,
            },
          ],
        },
      ],
      tools: [tool],
    });

    expect(first.type).toBe("message");
    expect(second.type).toBe("message");
    expect(models).toEqual([
      "zai-org/GLM-5.3-Flash",
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M2.7",
    ]);
  });

  it("switches to MiniMax for a scene correction after GLM's proposal is rejected", async () => {
    const models: string[] = [];
    const activities: string[] = [];
    const provider = new DahlProvider({
      apiKey: "dahl-test-secret",
      maxAttempts: 1,
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        models.push(body.model);
        if (body.model === "zai-org/GLM-5.3-Flash") {
          return completion(
            {
              content: null,
              tool_calls: [
                {
                  id: "bad-shape",
                  function: { name: tool.name, arguments: '{"rationale":"incorrect spec"}' },
                },
              ],
            },
            body.model,
          );
        }
        return completion(
          { content: "The rejected scene proposal has been corrected." },
          body.model,
        );
      },
    });
    const turn = provider.startTurn();
    const first = await turn.complete({
      systemPrompt: "system",
      messages: [{ role: "user", content: "Create a wooden chair." }],
      tools: [tool],
    });
    const second = await turn.complete({
      systemPrompt: "system",
      messages: [
        { role: "user", content: "Create a wooden chair." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "bad-shape",
              name: tool.name,
              input: { rationale: "incorrect spec" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "bad-shape",
              content: "Invalid arguments for propose_scene_patch — spec.version: Invalid input",
              isError: true,
            },
          ],
        },
      ],
      tools: [tool],
      onActivity: (message) => activities.push(message),
    });

    expect(first.type).toBe("message");
    expect(second.type).toBe("message");
    expect(models).toEqual(["zai-org/GLM-5.3-Flash", "MiniMaxAI/MiniMax-M2.7"]);
    expect(activities).toContain(
      "zai-org/GLM-5.3-Flash returned a scene proposal that failed validation; continuing with MiniMaxAI/MiniMax-M2.7.",
    );
  });

  it("runs selected specialists in parallel and sends their advisory output to GLM", async () => {
    const received: Array<{ model: string; system: string; messages: unknown[] }> = [];
    let active = 0;
    let maxActive = 0;
    const provider = new DahlProvider({
      apiKey: "dahl-test-secret",
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
        };
        received.push({
          model: body.model,
          system: body.messages[0]?.content ?? "",
          messages: body.messages,
        });
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (body.model === "deepseek-ai/DeepSeek-V4-Flash-0731") {
          return completion(
            {
              content: JSON.stringify({
                agent: "spatial",
                status: "success",
                recommendations: ["Keep the path clear of house bounds."],
                warnings: [],
                confidence: 0.91,
              }),
            },
            body.model,
          );
        }
        if (body.model === "MiniMaxAI/MiniMax-M2.7") {
          return completion(
            {
              content: JSON.stringify({
                agent: "composition",
                status: "success",
                recommendations: ["Use cedar and muted moss colors."],
                warnings: [],
                confidence: 0.84,
              }),
            },
            body.model,
          );
        }
        return completion({ content: "The scene patch is ready." }, body.model);
      },
    });
    const turn = provider.startTurn();
    const activities: string[] = [];
    const result = await turn.complete({
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "Create a Japanese village surrounded by mountains." }],
      tools: [tool],
      sceneContext: "Scene village revision abc; house bounds min=[-2,0,-2] max=[2,3,2].",
      onActivity: (message) => activities.push(message),
    });

    expect(result.type).toBe("message");
    expect(received.map((item) => item.model).sort()).toEqual(
      [
        "MiniMaxAI/MiniMax-M2.7",
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "zai-org/GLM-5.3-Flash",
      ].sort(),
    );
    expect(maxActive).toBe(2);
    const primary = received.find((item) => item.model === "zai-org/GLM-5.3-Flash")!;
    expect(primary.system).toContain("<authoritative_scene_snapshot>");
    expect(primary.system).toContain("Scene village revision abc");
    expect(primary.system).toContain("Keep the path clear of house bounds.");
    expect(primary.system).toContain("Use cedar and muted moss colors.");
    expect(activities).toContain("DeepSeek spatial agent: analysis completed.");
    expect(activities).toContain("MiniMax composition agent: analysis completed.");
    expect(turn.usage()).toEqual({ inputTokens: 36, outputTokens: 21 });
  });

  it("keeps simple edits on GLM alone and degrades gracefully when a specialist fails", async () => {
    const models: string[] = [];
    const provider = new DahlProvider({
      apiKey: "dahl-test-secret",
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        models.push(body.model);
        if (body.model === "deepseek-ai/DeepSeek-V4-Flash-0731")
          return new Response("upstream unavailable", { status: 503 });
        return completion({ content: "Done." }, body.model);
      },
      maxAttempts: 1,
      sleep: async () => {},
    });
    const turn = provider.startTurn();
    const result = await turn.complete({
      systemPrompt: "system",
      messages: [{ role: "user", content: "Make the cube red." }],
      tools: [tool],
    });
    expect(result.type).toBe("message");
    expect(models).toEqual(["zai-org/GLM-5.3-Flash"]);
  });
});
