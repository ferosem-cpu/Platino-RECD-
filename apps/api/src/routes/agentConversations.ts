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
import { canOverrideDuplicatePo, STAGE_KEY } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { findTakenSerials, parseSerialList, takenSerialsMessage } from "../lib/serials";
import { isSerialConflict, SERIAL_RACE_MESSAGE } from "../lib/uniqueViolations";
import { agentDuplicatePoMessage, createNewOrder, OrderCreationError } from "../lib/orderCreation";

/**
 * The confirmed action cannot be carried out because of the input itself (400) or because it
 * conflicts with existing data (409). The pending action is left untouched so the user can
 * reject it or have the assistant prepare it again. Any other error is a real failure (500).
 */
/** Shown to the user when confirming/rejecting fails for an internal reason (details go to the server log only). */
export const SAFE_ACTION_FAILED_MESSAGE =
  "Something went wrong on our side, so this action could not be completed and nothing was created. The card is still waiting - you can try again or reject it.";
export const SAFE_ACTION_DONE_BUT_NOT_SAVED_MESSAGE =
  "The action was carried out, but the chat could not be updated afterwards. Please refresh the page to see the result, and do not confirm it again.";

export class AgentActionError extends Error {
  constructor(public readonly status: 400 | 409, message: string) {
    super(message);
    this.name = "AgentActionError";
  }
}
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
export async function executeConfirmedAction(
  toolName: string,
  input: Record<string, unknown>,
  userId: string,
  /** Role of the confirming user - only used to word a duplicate-PO refusal; it never grants an override. */
  roleKey?: string | null,
): Promise<string> {
  switch (toolName) {
    case "create_order": {
      // Serials are mandatory (same rule as POST /orders). An action proposed before this rule
      // existed has none stored - refuse it rather than create "serial pending" units.
      const serialCheck = parseSerialList(input.recdSerials, Number(input.quantity));
      if ("error" in serialCheck) {
        throw new AgentActionError(400, `${serialCheck.error} Reject this card and ask the assistant to prepare the order again with the serial numbers.`);
      }
      // A PO number is mandatory (same rule as POST /orders). An action proposed before this rule existed has none
      // stored - refuse it rather than create an order without a PO.
      const poNumber = typeof input.poNumber === "string" ? input.poNumber.trim() : "";
      if (!poNumber || poNumber.length > 60) {
        throw new AgentActionError(400, "This order has no valid customer PO number (1-60 characters). Reject this card and ask the assistant to prepare the order again with the PO number.");
      }
      const taken = await findTakenSerials(serialCheck.serials);
      if (taken.length) throw new AgentActionError(409, takenSerialsMessage(taken));

      // Same creation path as POST /orders: unknown customer/product -> 400, same-customer duplicate PO -> 409, order
      // number retried, order + site + units in one transaction. The assistant cannot override a duplicate PO: an
      // approved duplicate has to be entered by an administrator on the Orders page (allowDuplicatePo).
      try {
        const order = await createNewOrder({
          customerId: String(input.customerId),
          productId: String(input.productId),
          quantity: Number(input.quantity),
          value: input.value !== undefined && input.value !== null ? Number(input.value) : undefined,
          orderDate: input.orderDate ? new Date(String(input.orderDate)).toISOString() : undefined,
          promisedDeliveryDate: input.promisedDeliveryDate ? new Date(String(input.promisedDeliveryDate)).toISOString() : undefined,
          plannedExhaustHookupType: (input.plannedExhaustHookupType as string | null) ?? undefined,
          poNumber,
          poDate: input.poDate ? new Date(String(input.poDate)).toISOString() : undefined,
          serials: serialCheck.serials,
          salesEngineerId: userId,
          allowDuplicatePo: false,
          roleKey: null,
        });
        return order.id;
      } catch (err) {
        if (err instanceof OrderCreationError) {
          if (err.code === "DUPLICATE_PO" && err.existingOrderNumber) {
            throw new AgentActionError(err.status, agentDuplicatePoMessage(poNumber, err.existingOrderNumber, canOverrideDuplicatePo(roleKey)));
          }
          throw new AgentActionError(err.status, err.message);
        }
        if (isSerialConflict(err)) throw new AgentActionError(409, `${SERIAL_RACE_MESSAGE}.`);
        throw err;
      }
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

  let resultId: string | null = null;
  if (outcome === "confirmed") {
    try {
      resultId = await executeConfirmedAction(action.toolName, action.input as Record<string, unknown>, req.auth!.userId, req.auth!.roleKey);
    } catch (err) {
      // Invalid input / a real conflict: a client error with our own message; the action stays pending.
      if (err instanceof AgentActionError) return res.status(err.status).json({ error: err.message });
      // Anything else is an internal failure: keep the details in the server log, never in the response.
      console.error("[agent] confirming action failed", { actionId: action.id, toolName: action.toolName }, err);
      return res.status(500).json({ error: SAFE_ACTION_FAILED_MESSAGE });
    }
  }

  try {
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
    console.error("[agent] saving the action outcome failed", { actionId: action.id, outcome, resultId }, err);
    // If a confirmed action already ran, say so: it must not be confirmed a second time.
    return res.status(500).json({ error: resultId ? SAFE_ACTION_DONE_BUT_NOT_SAVED_MESSAGE : SAFE_ACTION_FAILED_MESSAGE });
  }
}

agentConversationsRouter.post("/conversations/:id/actions/:actionId/confirm", authenticate, (req: AuthenticatedRequest, res) =>
  handleResolveAction(req, res, "confirmed"),
);

agentConversationsRouter.post("/conversations/:id/actions/:actionId/reject", authenticate, (req: AuthenticatedRequest, res) =>
  handleResolveAction(req, res, "rejected"),
);
