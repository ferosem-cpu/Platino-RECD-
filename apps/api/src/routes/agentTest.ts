/** Temporary manual-verification route for the agent loop - NOT the real chat endpoint.
 * No conversation persistence (Supabase table, §55 item 2), no Super-Admin visibility gate
 * (§55 item 2), no confirm-gated writes (no write tools exist yet). Exists purely so the
 * LLM tool-use loop + Drive tools can be exercised end-to-end with a real provider key before
 * the rest of the agent module (persistence, visibility, write tools, frontend bubble) is
 * built. Gated to any authenticated user for now - tighten before this becomes the real
 * endpoint.
 */
import { Router } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { authenticate } from "../middleware/auth";
import { runAgentTurn } from "../agent/llm";
import { buildAgentSystemPrompt } from "../agent/systemPrompt";
import { allTools } from "../agent/tools/registry";
import type { UnifiedMessage } from "../agent/providers/types";

export const agentTestRouter = Router();

agentTestRouter.post("/chat-test", authenticate, async (req: AuthenticatedRequest, res) => {
  const { message, history } = req.body as { message?: string; history?: UnifiedMessage[] };
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }
  if (!req.auth) return res.status(401).json({ error: "Not authenticated" });

  const priorHistory: UnifiedMessage[] = Array.isArray(history) ? history : [];
  const newHistory: UnifiedMessage[] = [...priorHistory, { role: "user", content: message }];

  try {
    const result = await runAgentTurn({
      systemPrompt: buildAgentSystemPrompt(!!req.auth.customerId),
      history: newHistory,
      tools: allTools,
      auth: req.auth,
    });
    res.json({ reply: result.reply, history: result.history });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
