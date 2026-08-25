import Anthropic from "@anthropic-ai/sdk";
import type { LlmAdapter, SendMessageParams, SendMessageResult, UnifiedMessage } from "./types";
import { ProviderCallError } from "./types";

export interface AnthropicAdapterConfig {
  providerName: string; // the user-given label, for error messages
  apiKey: string;
  model: string;
}

function toAnthropicMessages(messages: UnifiedMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      result.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      result.push({ role: "assistant", content });
    } else {
      // Anthropic groups tool results as user-role content blocks. Consecutive tool
      // messages should ideally merge into one user turn, but Anthropic also accepts
      // them as separate user turns, so keep this simple.
      result.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  }
  return result;
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): LlmAdapter {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
      try {
        const response = await client.messages.create({
          model: config.model,
          max_tokens: 2048,
          system: params.systemPrompt,
          tools: params.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
          messages: toAnthropicMessages(params.messages),
        });

        const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        return {
          text: textBlocks.map((b) => b.text).join("\n").trim(),
          toolCalls: toolUseBlocks.map((b) => ({
            id: b.id,
            name: b.name,
            input: (b.input ?? {}) as Record<string, unknown>,
          })),
        };
      } catch (err) {
        throw new ProviderCallError(
          `Anthropic provider "${config.providerName}" call failed: ${(err as Error).message}`,
          config.providerName,
          err,
        );
      }
    },
  };
}
