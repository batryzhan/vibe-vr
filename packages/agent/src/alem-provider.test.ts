import { describe, expect, it, vi } from "vitest";
import { AlemProvider } from "./alem-provider.ts";

describe("AlemProvider", () => {
  it("sends the actual reference pixels as multimodal content alongside the user query", async () => {
    const referenceImage = "data:image/png;base64,aGVsbG8=";
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContainEqual({
        type: "image_url",
        image_url: { url: referenceImage },
      });
      expect(body.messages[2]).toEqual({ role: "user", content: "Build this object" });
      return Response.json({ choices: [{ message: { content: "Done" } }] });
    });
    const result = await new AlemProvider({ apiKey: "test", fetcher }).startTurn().complete({
      systemPrompt: "Use the scene tools",
      messages: [{ role: "user", content: "Build this object" }],
      tools: [],
      referenceImage,
    });
    expect(result.type).toBe("message");
  });
  it("calls Alem chat completions and converts tool calls and usage", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: unknown[];
        tools: unknown[];
        chat_template_kwargs: { enable_thinking: boolean };
      };
      expect(body.model).toBe("qwen3-8");
      expect(body.chat_template_kwargs.enable_thinking).toBe(false);
      expect(body.messages[1]).toEqual({ role: "user", content: "A simple chair" });
      expect(body.tools).toHaveLength(1);
      return Response.json({
        choices: [
          {
            message: {
              content: "Building it",
              tool_calls: [
                { id: "call-1", function: { name: "scene", arguments: '{"action":"create"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      });
    });
    const provider = new AlemProvider({ apiKey: "test-secret", fetcher });
    const turn = provider.startTurn();
    const result = await turn.complete({
      systemPrompt: "Create a chair",
      messages: [{ role: "user", content: [{ type: "text", text: "A simple chair" }] }],
      tools: [{ name: "scene", description: "Edit the 3D scene", inputSchema: { type: "object" } }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://llm.alem.ai/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-secret" }),
      }),
    );
    expect(result).toMatchObject({
      type: "message",
      text: "Building it",
      toolCalls: [{ id: "call-1", name: "scene", input: { action: "create" } }],
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(turn.usage()).toEqual({ inputTokens: 12, outputTokens: 7 });
  });
});
