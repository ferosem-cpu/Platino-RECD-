/** Agent LLM tool interface - provider-agnostic shape, adapted to Anthropic's tool-use
 * format by llm.ts. inputSchema is a plain JSON Schema object (not zod) so it can be handed
 * directly to the Anthropic API without a conversion step.
 */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Executes the tool. Receives parsed input matching inputSchema and the calling user's
   * auth context, so tools can enforce per-role visibility the same way routes do. */
  handler: (input: Record<string, unknown>, auth: AgentAuthContext) => Promise<unknown>;
}

export interface AgentAuthContext {
  userId: string;
  roleKey: string;
  customerId?: string | null;
  vendorId?: string | null;
  permissions: Set<string>;
  /** The AgentConversation this turn belongs to - needed by write tools so they can attach
   * an AgentPendingAction to the right thread. Not set for the throwaway /agent/chat-test
   * route (no persisted conversation), so write tools must handle it being absent. */
  conversationId?: string;
}
