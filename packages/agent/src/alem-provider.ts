/** OpenAI-compatible provider for Alem AI chat completions. */
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnOptions,
  TokenUsage,
} from "@vibe-vr/shared/ports/llm-provider";

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };
type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "user";
      content: Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      >;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

function toWireMessage(message: LLMMessage): WireMessage[] {
  if (typeof message.content === "string")
    return message.role === "user"
      ? [{ role: "user", content: message.content }]
      : [{ role: "assistant", content: message.content }];
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const calls = message.content.filter((b) => b.type === "tool_use");
  const results = message.content.filter((b) => b.type === "tool_result");

  // NapContextEngine represents even plain user messages as content blocks. Keeping the
  // original role is essential: promoting those text blocks to `assistant` leaves LiteLLM
  // with no user query and Alem rejects the request with a 400.
  if (message.role === "user") {
    const content = [
      text,
      ...results.map((result) => `Tool result (${result.toolCallId}): ${result.content}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    return content ? [{ role: "user", content }] : [];
  }

  const output: WireMessage[] = [];
  if (text || calls.length)
    output.push({
      role: "assistant",
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((b) => ({
              id: b.id,
              type: "function" as const,
              function: { name: b.name, arguments: JSON.stringify(b.input) },
            })),
          }
        : {}),
    });
  for (const result of results)
    output.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
  return output;
}

export class AlemProvider implements LLMProvider {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #fetcher: typeof fetch;

  constructor(
    options: { apiKey?: string; baseUrl?: string; model?: string; fetcher?: typeof fetch } = {},
  ) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://llm.alem.ai/v1").replace(/\/$/, "");
    this.#model = options.model ?? "qwen3-8";
    this.#fetcher = options.fetcher ?? fetch;
  }

  startTurn(options: LLMTurnOptions = {}): LLMTurn {
    const usage = { ...EMPTY_USAGE };
    return {
      usage: () => ({ ...usage }),
      complete: async (request: LLMRequest) => {
        if (options.credentials)
          return {
            type: "error",
            message: "Per-user keys are not supported by the Alem provider.",
            retryable: false,
            usage: { ...EMPTY_USAGE },
          };
        if (!this.#apiKey)
          return {
            type: "error",
            message: "Set ALEM_API_KEY in apps/api/.env.",
            retryable: false,
            usage: { ...EMPTY_USAGE },
          };
        try {
          const messages: WireMessage[] = [
            { role: "system", content: request.systemPrompt },
            ...(request.referenceImage
              ? [
                  {
                    role: "user" as const,
                    content: [
                      {
                        type: "text" as const,
                        text: "Reference image for this turn. Build the object in this image as an editable 3D scene, following the user's prompt and the supported scene tools.",
                      },
                      { type: "image_url" as const, image_url: { url: request.referenceImage } },
                    ],
                  },
                ]
              : []),
            ...request.messages.flatMap(toWireMessage),
          ];
          const response = await this.#fetcher(`${this.#baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              "Content-Type": "application/json",
            },
            ...(request.signal ? { signal: request.signal } : {}),
            body: JSON.stringify({
              model: options.model ?? this.#model,
              // Alem's Qwen endpoint supports disabling extended thinking. Spend the
              // output budget on the scene itself so short demo prompts start promptly.
              chat_template_kwargs: { enable_thinking: false },
              messages,
              ...(request.tools.length
                ? {
                    tools: request.tools.map((tool) => ({
                      type: "function",
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                      },
                    })),
                    tool_choice: "auto",
                  }
                : {}),
            }),
          });
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            return {
              type: "error",
              message: `Alem API error ${response.status}: ${detail}`,
              retryable: response.status >= 500 || response.status === 429,
              usage: { ...EMPTY_USAGE },
            };
          }
          const data = (await response.json()) as {
            choices?: Array<{
              finish_reason?: string;
              message?: {
                content?: string | null;
                tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const result = data.choices?.[0];
          if (!result?.message)
            return {
              type: "error",
              message: "Alem API returned no message.",
              retryable: true,
              usage: { ...EMPTY_USAGE },
            };
          const nextUsage = {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
          };
          usage.inputTokens += nextUsage.inputTokens;
          usage.outputTokens += nextUsage.outputTokens;
          const toolCalls: LLMToolCall[] = [];
          for (const call of result.message.tool_calls ?? []) {
            try {
              const input = JSON.parse(call.function.arguments) as unknown;
              if (input && typeof input === "object" && !Array.isArray(input))
                toolCalls.push({
                  id: call.id,
                  name: call.function.name,
                  input: input as Record<string, unknown>,
                });
            } catch {
              /* Ignore malformed tool arguments; the caller can use the text response. */
            }
          }
          return {
            type: "message",
            text: result.message.content ?? "",
            toolCalls,
            usage: nextUsage,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { type: "error", message, retryable: true, usage: { ...EMPTY_USAGE } };
        }
      },
    };
  }
}
