/** Provider-agnostic conversation & tool-call shape. Each adapter (Anthropic, OpenAI-
 * compatible, ...) translates its native request/response format to/from this - so the
 * agent loop and tool registry never need to know which provider is actually running.
 */

export interface UnifiedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Opaque provider-specific data that must be echoed back verbatim on a later turn for
   * some providers to accept the continued conversation (e.g. Gemini's OpenAI-compat layer
   * requires its `extra_content` "thought signature" to be preserved across turns for
   * multi-turn tool calling to work - dropping it causes a bare 400 on the next call).
   * Adapters that don't need this simply leave it undefined and ignore it on the way back in. */
  providerMetadata?: unknown;
}

export type UnifiedMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: UnifiedToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface UnifiedToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface SendMessageParams {
  systemPrompt: string;
  messages: UnifiedMessage[];
  tools: UnifiedToolSchema[];
}

export interface SendMessageResult {
  /** Plain text the assistant produced this turn (may be empty if it only made tool calls). */
  text: string;
  toolCalls: UnifiedToolCall[];
}

export interface LlmAdapter {
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
}

/** Thrown by an adapter for errors that should trigger fallback to the next configured
 * provider (auth failure, rate limit, network/timeout, provider outage) rather than being
 * treated as a final answer. Adapters should let genuinely unexpected errors propagate as-is
 * if they don't fit this - but in practice almost all provider call failures qualify. */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    public readonly providerName: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}
