/** Core agent loop: sends a conversation through a chain of configured LLM providers (tried
 * in priority order, falling back to the next on failure), executes any tool calls the model
 * makes, feeds the results back, and repeats until the model returns a plain text answer (or
 * a turn limit is hit, as a safety valve against infinite tool loops).
 */
import type { AgentLlmProvider } from "@prisma/client";
import type { AgentTool, AgentAuthContext } from "./tools/types";
import { getToolByName } from "./tools/registry";
import type { UnifiedMessage, UnifiedToolSchema, LlmAdapter, SendMessageResult } from "./providers/types";
import { ProviderCallError } from "./providers/types";
import { createAdapterForRow, loadActiveProvidersInOrder } from "./providers/factory";

const MAX_TOOL_TURNS = 8;

export type AgentMessage = UnifiedMessage;

export interface RunAgentTurnParams {
  systemPrompt: string;
  history: UnifiedMessage[];
  tools: AgentTool[];
  auth: AgentAuthContext;
  /** Called for each tool the model wants to run, before it executes - lets a caller
   * short-circuit (e.g. reject) a write-tool call by returning a replacement result instead
   * of letting handler() run. Not yet used by any tool (all current tools are read-only). */
  onToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<{ intercepted: true; result: unknown } | { intercepted: false }>;
}

export interface RunAgentTurnResult {
  reply: string;
  history: UnifiedMessage[];
}

function toUnifiedTools(tools: AgentTool[]): UnifiedToolSchema[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function sendWithFallback(
  providers: AgentLlmProvider[],
  adapters: Map<string, LlmAdapter>,
  params: { systemPrompt: string; messages: UnifiedMessage[]; tools: UnifiedToolSchema[] },
): Promise<SendMessageResult> {
  const failures: string[] = [];
  for (const providerRow of providers) {
    let adapter = adapters.get(providerRow.id);
    if (!adapter) {
      adapter = createAdapterForRow(providerRow);
      adapters.set(providerRow.id, adapter);
    }
    try {
      return await adapter.sendMessage(params);
    } catch (err) {
      const message = err instanceof ProviderCallError ? err.message : (err as Error).message;
      failures.push(`${providerRow.name}: ${message}`);
    }
  }
  throw new Error(`All configured LLM providers failed:\n${failures.join("\n")}`);
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
  const { systemPrompt, tools, onToolCall } = params;
  const unifiedTools = toUnifiedTools(tools);

  const providers = await loadActiveProvidersInOrder();
  if (providers.length === 0) {
    throw new Error(
      "No LLM provider is configured for the agent yet. Add one under Settings > Agent providers.",
    );
  }
  const adapters = new Map<string, LlmAdapter>();

  let history = [...params.history];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await sendWithFallback(providers, adapters, {
      systemPrompt,
      messages: history,
      tools: unifiedTools,
    });

    history = [...history, { role: "assistant", content: response.text, toolCalls: response.toolCalls }];

    if (response.toolCalls.length === 0) {
      return { reply: response.text, history };
    }

    for (const call of response.toolCalls) {
      let resultValue: unknown;
      try {
        const intercepted = await onToolCall?.(call.name, call.input);
        if (intercepted?.intercepted) {
          resultValue = intercepted.result;
        } else {
          const tool = getToolByName(call.name);
          if (!tool) {
            resultValue = { error: `Unknown tool: ${call.name}` };
          } else {
            resultValue = await tool.handler(call.input, params.auth);
          }
        }
      } catch (err) {
        resultValue = { error: (err as Error).message };
      }
      history = [
        ...history,
        { role: "tool", toolCallId: call.id, toolName: call.name, content: JSON.stringify(resultValue) },
      ];
    }
  }

  return {
    reply: "I wasn't able to finish that within the allowed number of steps - could you rephrase or simplify the request?",
    history,
  };
}
