/** Real chat endpoint for the in-app agent - persisted conversations, one thread per row
 * (see AgentConversation in schema.prisma). Replaces the throwaway /agent/chat-test route
 * for actual use; chat-test stays for manual verification without touching real user data.
 * Every route here is scoped to the caller's own conversations - no admin override, this is
 * personal chat history like any other user's own data.
 *
 * The upstream fork's finance write tools (create_quotation / create_invoice /
 * create_purchase_order / create_expense) still aren't part of this app - no finance module
 * here. create_order and create_product ARE, behind the same AgentPendingAction confirm-gate
 * pattern (see executeConfirmedAction and the /actions/:actionId/confirm|reject routes below).
 */
import { Router } from "express";
import { STAGE_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { authenticate, type AuthenticatedRequest } from "../middleware/auth";
import { runAgentTurn } from "../agent/llm";
import { buildAgentSystemPrompt } from "../agent/systemPrompt";
import { allTools } from "../agent/tools/registry";
import type { UnifiedMessage } from "../agent/providers/types";

export const agentConversationsRouter = Router();

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed || "New conversation";
}

agentConversationsRouter.get("/conversations", authenticate, async (req: AuthenticatedRequest, res) => {
  const rows = await prisma.agentConversation.findMany({
    where: { userId: req.auth!.userId },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ conversations: rows });
});

agentConversationsRouter.post("/conversations", authenticate, async (req: AuthenticatedRequest, res) => {
  const row = await prisma.agentConversation.create({
    data: { userId: req.auth!.userId, messages: [] },
  });
  res.status(201).json({ id: row.id, title: row.title, messages: [], createdAt: row.createdAt, updatedAt: row.updatedAt });
});

agentConversationsRouter.get("/conversations/:id", authenticate, async (req: AuthenticatedRequest, res) => {
  const row = await prisma.agentConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!row || row.userId !== req.auth!.userId) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  res.json({ id: row.id, title: row.title, messages: row.messages, createdAt: row.createdAt, updatedAt: row.updatedAt });
});

agentConversationsRouter.delete("/conversations/:id", authenticate, async (req: AuthenticatedRequest, res) => {
  const row = await prisma.agentConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!row || row.userId !== req.auth!.userId) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  await prisma.agentConversation.delete({ where: { id: row.id } });
  res.status(204).send();
});

agentConversationsRouter.post("/conversations/:id/messages", authenticate, async (req: AuthenticatedRequest, res) => {
  const { message } = req.body as { message?: string };
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  const row = await prisma.agentConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!row || row.userId !== req.auth!.userId) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const priorHistory = (row.messages as unknown as UnifiedMessage[]) ?? [];
  const newHistory: UnifiedMessage[] = [...priorHistory, { role: "user", content: message }];

  try {
    const company = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const result = await runAgentTurn({
      systemPrompt: buildAgentSystemPrompt(!!req.auth!.customerId, company?.agentCustomInstructions),
      history: newHistory,
      tools: allTools,
      auth: { ...req.auth!, conversationId: row.id },
    });

    const updated = await prisma.agentConversation.update({
      where: { id: row.id },
      data: {
        messages: result.history as unknown as object,
        title: row.title ?? deriveTitle(message),
      },
    });

    res.json({ reply: result.reply, id: updated.id, title: updated.title, messages: updated.messages });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Executes the real Prisma write for one confirmed pending action, dispatched by toolName.
 * Mirrors the equivalent REST create-route's logic exactly (see routes/orders.ts,
 * routes/products.ts) rather than reinventing it, so a confirmed agent action and a normal
 * UI-created record behave identically. Returns the created record's id.
 */
async function executeConfirmedAction(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
): Promise<string> {
  switch (toolName) {
    case "create_order": {
      const firstStage = await prisma.stageDefinition.findUniqueOrThrow({ where: { key: STAGE_KEY.ORDER_RECEIVED } });
      const orderNumber = `ORD-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const order = await prisma.order.create({
        data: {
          orderNumber,
          customerId: String(input.customerId),
          productId: String(input.productId),
          quantity: Number(input.quantity),
          value: input.value !== undefined && input.value !== null ? Number(input.value) : undefined,
          orderDate: input.orderDate ? new Date(String(input.orderDate)) : undefined,
          promisedDeliveryDate: input.promisedDeliveryDate ? new Date(String(input.promisedDeliveryDate)) : undefined,
          plannedExhaustHookupType: (input.plannedExhaustHookupType as string | null) ?? undefined,
          salesEngineerId: userId,
          // The agent has no way to know physical serials: units are created "serial pending"
          // (serialNo null) and show up under /recd-units?pending=1 until staff enter them.
          site: { create: { currentStageId: firstStage.id } },
          poNumber: (input.poNumber as string | null) ?? undefined,
        },
        include: { site: true },
      });
      await prisma.recdUnit.createMany({
        data: Array.from({ length: Math.max(1, Number(input.quantity)) }, () => ({
          orderId: order.id,
          siteId: order.site?.id,
          productId: String(input.productId),
        })),
      });
      return order.id;
    }
    case "create_product": {
      const product = await prisma.product.create({
        data: {
          name: String(input.name),
          model: String(input.model),
          ratingSpec: (input.ratingSpec as string | null) ?? undefined,
          capacityKva: input.capacityKva !== undefined && input.capacityKva !== null ? Number(input.capacityKva) : undefined,
          warrantyMonths: input.warrantyMonths !== undefined && input.warrantyMonths !== null ? Number(input.warrantyMonths) : undefined,
          shape: (input.shape as string | null) ?? undefined,
          dimensions: (input.dimensions as string | null) ?? undefined,
          weightKg: input.weightKg !== undefined && input.weightKg !== null ? Number(input.weightKg) : undefined,
        },
      });
      return product.id;
    }
    default:
      throw new Error(`Don't know how to execute confirmed action for tool "${toolName}".`);
  }
}

/** Rewrites the tool-result message in a conversation's stored history that matches this
 * actionId, so the transcript reflects the resolved (confirmed/rejected) state instead of
 * staying frozen on "pending_confirmation" - the next chat turn's context, and the frontend
 * re-render, both pick this up automatically. */
function resolveActionInHistory(
  messages: UnifiedMessage[],
  actionId: string,
  resolution: Record<string, unknown>,
): UnifiedMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool" || !m.content) return m;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed.actionId === actionId) {
        return { ...m, content: JSON.stringify({ ...parsed, ...resolution }) };
      }
    } catch {
      // not JSON - not a tool-result we care about
    }
    return m;
  });
}

async function handleResolveAction(
  req: AuthenticatedRequest,
  res: import("express").Response,
  outcome: "confirmed" | "rejected",
) {
  const conversation = await prisma.agentConversation.findUnique({ where: { id: String(req.params.id) } });
  if (!conversation || conversation.userId !== req.auth!.userId) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  const action = await prisma.agentPendingAction.findUnique({ where: { id: String(req.params.actionId) } });
  if (!action || action.conversationId !== conversation.id) {
    return res.status(404).json({ error: "Pending action not found" });
  }
  if (action.status !== "pending") {
    return res.status(400).json({ error: `This action was already ${action.status}.` });
  }

  try {
    let resultId: string | null = null;
    if (outcome === "confirmed") {
      resultId = await executeConfirmedAction(action.toolName, action.input as Record<string, unknown>, req.auth!.userId);
    }

    await prisma.agentPendingAction.update({
      where: { id: action.id },
      data: { status: outcome, resultId, resolvedAt: new Date() },
    });

    const priorHistory = (conversation.messages as unknown as UnifiedMessage[]) ?? [];
    const newHistory = resolveActionInHistory(priorHistory, action.id, { status: outcome, resultId });
    const updated = await prisma.agentConversation.update({
      where: { id: conversation.id },
      data: { messages: newHistory as unknown as object },
    });

    res.json({ status: outcome, resultId, messages: updated.messages });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

agentConversationsRouter.post("/conversations/:id/actions/:actionId/confirm", authenticate, (req: AuthenticatedRequest, res) =>
  handleResolveAction(req, res, "confirmed"),
);

agentConversationsRouter.post("/conversations/:id/actions/:actionId/reject", authenticate, (req: AuthenticatedRequest, res) =>
  handleResolveAction(req, res, "rejected"),
);
