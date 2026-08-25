import OpenAI from "openai";
import type { LlmAdapter, SendMessageParams, SendMessageResult, UnifiedMessage } from "./types";
import { ProviderCallError } from "./types";

export interface OpenAICompatibleAdapterConfig {
  providerName: string; // the user-given label, for error messages
  apiKey: string;
  model: string;
  /** Custom endpoint for non-OpenAI providers exposing an OpenAI-compatible API (Groq,
   * Together, DeepSeek, OpenRouter, Fireworks, Mistral, etc). Omit for real OpenAI. */
  baseUrl?: string;
}

function toOpenAIMessages(
  systemPrompt: string,
  messages: UnifiedMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      result.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      result.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          // Some providers (Gemini's OpenAI-compat layer) attach extra out-of-spec fields
          // (e.g. extra_content.google.thought_signature) to each tool_call and REQUIRE them
          // echoed back verbatim on the next turn, or reject the request with a bare 400.
          // The OpenAI SDK's types don't model this, but it round-trips fine at runtime.
          ...((tc.providerMetadata as object) ?? {}),
        })) as OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined,
      });
    } else {
      result.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return result;
}

export function createOpenAICompatibleAdapter(config: OpenAICompatibleAdapterConfig): LlmAdapter {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });

  return {
    async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
      try {
        const response = await client.chat.completions.create({
          model: config.model,
          messages: toOpenAIMessages(params.systemPrompt, params.messages),
          tools: params.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        });

        const message = response.choices[0]?.message;
        if (!message) {
          throw new Error("Provider returned no choices in the response.");
        }

        const toolCalls = (message.tool_calls ?? []).flatMap((tc) => {
          if (tc.type !== "function") return [];
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments || "{}");
          } catch {
            // Malformed JSON from the model - pass through empty input rather than crash;
            // the tool handler will likely fail validation and report that back to the model.
          }
          // Capture any extra out-of-spec fields the provider attached (see the comment in
          // toOpenAIMessages above) so they can be echoed back on the next turn.
          const { id: _id, type: _type, function: _fn, ...extra } = tc as unknown as Record<string, unknown> & {
            id: string;
          };
          return [
            {
              id: tc.id,
              name: tc.function.name,
              input,
              providerMetadata: Object.keys(extra).length > 0 ? extra : undefined,
            },
          ];
        });

        return { text: (message.content ?? "").trim(), toolCalls };
      } catch (err) {
        throw new ProviderCallError(
          `Provider "${config.providerName}" call failed: ${(err as Error).message}`,
          config.providerName,
          err,
        );
      }
    },
  };
}
