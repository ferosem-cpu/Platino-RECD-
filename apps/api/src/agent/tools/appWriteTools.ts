/** Confirm-gated write tools for the in-app agent. Unlike the read tools, these NEVER write
 * real data from the tool handler itself - they validate the proposed input, resolve any
 * name references (customer/product) to real ids, and create an AgentPendingAction row
 * describing what *would* be created. The actual Prisma write only happens when the user
 * clicks Confirm in the chat UI (see the /conversations/:id/actions/:actionId/confirm route
 * in agentConversations.ts), which reuses the same logic as the real REST create-route.
 *
 * Ported from the upstream Zan-APP fork's zanAppWriteTools.ts, trimmed to the two tools this
 * app actually has a use for (orders/products - no finance module here) and adapted to this
 * app's own Order/Product shape.
 */
import { canOverrideDuplicatePo, PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../../lib/prisma";
import { agentDuplicatePoMessage } from "../../lib/orderCreation";
import { findTakenSerials, parseSerialList, takenSerialsMessage } from "../../lib/serials";
import type { AgentTool } from "./types";

function forbidden(what: string) {
  return { error: `You don't have permission to create ${what}.` };
}

const createOrderTool: AgentTool = {
  name: "create_order",
  description:
    "Propose a new sales order (and its site) for a customer - one RECD product, quantity, " +
    "and commercial value. This does NOT create the order immediately - it prepares it and " +
    "shows the user a confirm card in the chat; only THEY can approve it by clicking Confirm. " +
    "The order number is only allocated at confirm time - after calling this, tell the user " +
    "you've prepared it for their review, never say it has been created or quote an order " +
    "number, since none exists yet.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Customer id, if already known (e.g. from a prior search)." },
      customerName: {
        type: "string",
        description: "Customer name to look up if customerId isn't known. Provide one of customerId or customerName.",
      },
      productId: { type: "string", description: "Product id, if already known." },
      productNameOrModel: {
        type: "string",
        description: "Product name or model to look up if productId isn't known (e.g. 'RECD-500'). Provide one of productId or productNameOrModel.",
      },
      quantity: { type: "number", description: "Number of units. Defaults to 1 if omitted." },
      recdSerials: {
        type: "array",
        items: { type: "string" },
        description:
          "REQUIRED: the RECD serial number of every unit, exactly 'quantity' of them, each globally unique. " +
          "Ask the user for them - never invent or guess serial numbers.",
      },
      poNumber: {
        type: "string",
        description: "REQUIRED: the customer's purchase order (PO) number, 1-60 characters. Ask the user for it - never invent one.",
      },
      poDate: { type: "string", description: "ISO date (YYYY-MM-DD) of the customer PO, if known." },
      value: { type: "number", description: "Commercial order value in rupees, if known - optional, can be filled in later." },
      orderDate: { type: "string", description: "ISO date (YYYY-MM-DD). Defaults to today if omitted." },
      promisedDeliveryDate: { type: "string", description: "ISO date (YYYY-MM-DD), if known." },
      plannedExhaustHookupType: {
        type: "string",
        enum: ["replace_existing_silencer", "add_after_existing_exhaust"],
        description: "How the RECD will be fitted, if known.",
      },
    },
    required: ["recdSerials", "poNumber"],
  },
  handler: async (input, auth) => {
    if (!auth.permissions.has(PERMISSION_KEY.MANAGE_ORDERS)) return forbidden("orders");
    if (!auth.conversationId) return { error: "No active conversation - cannot propose a write action here." };

    const customerId = input.customerId ? String(input.customerId) : null;
    const customerName = input.customerName ? String(input.customerName) : null;
    const productId = input.productId ? String(input.productId) : null;
    const productQuery = input.productNameOrModel ? String(input.productNameOrModel) : null;
    const quantity = input.quantity !== undefined ? Number(input.quantity) : 1;
    const value = input.value !== undefined ? Number(input.value) : undefined;
    const orderDateStr = input.orderDate ? String(input.orderDate) : new Date().toISOString().slice(0, 10);
    const promisedDeliveryDateStr = input.promisedDeliveryDate ? String(input.promisedDeliveryDate) : null;
    const plannedExhaustHookupType = input.plannedExhaustHookupType ? String(input.plannedExhaustHookupType) : null;
    const poNumber = typeof input.poNumber === "string" ? input.poNumber.trim() : "";
    const poDateStr = input.poDate ? String(input.poDate) : null;

    if (!poNumber) return { error: "poNumber is required - ask the user for the customer's PO number." };
    if (poNumber.length > 60) return { error: "poNumber must be at most 60 characters." };
    if (poDateStr && Number.isNaN(new Date(poDateStr).getTime())) return { error: "poDate must be a valid date (YYYY-MM-DD)." };
    if (!customerId && !customerName) return { error: "Provide either customerId or customerName." };
    if (!productId && !productQuery) return { error: "Provide either productId or productNameOrModel." };
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: "quantity must be a positive number." };
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return { error: "value must be a non-negative number." };
    if (!Number.isInteger(quantity)) return { error: "quantity must be a whole number." };

    // Same rule as POST /orders: one distinct, unregistered serial per physical unit.
    const serialCheck = parseSerialList(input.recdSerials, quantity);
    if ("error" in serialCheck) return serialCheck;
    const taken = await findTakenSerials(serialCheck.serials);
    if (taken.length) return { error: takenSerialsMessage(taken) };

    let customer = customerId ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
    if (!customer && customerName) {
      const matches = await prisma.customer.findMany({
        where: { name: { contains: customerName, mode: "insensitive" } },
        take: 5,
      });
      if (matches.length === 1) {
        customer = matches[0];
      } else if (matches.length > 1) {
        return {
          error: `Multiple customers match "${customerName}": ${matches
            .map((c) => `${c.name} (id: ${c.id})`)
            .join(", ")}. Ask the user which one, then retry with the exact customerId.`,
        };
      } else {
        const allCustomers = await prisma.customer.findMany({ select: { name: true }, take: 20 });
        return {
          error: `No customer matching "${customerName}". Existing customers: ${allCustomers.map((c) => c.name).join(", ") || "(none yet)"}. Ask the user which one, or offer to add a new customer first.`,
        };
      }
    }
    if (!customer) return { error: `No customer found with id ${customerId}.` };

    let product = productId ? await prisma.product.findUnique({ where: { id: productId } }) : null;
    if (!product && productQuery) {
      const matches = await prisma.product.findMany({
        where: { OR: [{ name: { contains: productQuery, mode: "insensitive" } }, { model: { contains: productQuery, mode: "insensitive" } }] },
        take: 5,
      });
      if (matches.length === 1) {
        product = matches[0];
      } else if (matches.length > 1) {
        return {
          error: `Multiple products match "${productQuery}": ${matches
            .map((p) => `${p.name} / ${p.model} (id: ${p.id})`)
            .join(", ")}. Ask the user which one, then retry with the exact productId.`,
        };
      } else {
        const allProducts = await prisma.product.findMany({ select: { name: true, model: true }, take: 30 });
        return {
          error: `No product matching "${productQuery}". Existing products: ${allProducts.map((p) => `${p.name} (${p.model})`).join(", ") || "(none yet)"}. Ask the user which one, or offer to add a new product first via create_product.`,
        };
      }
    }
    if (!product) return { error: `No product found with id ${productId}.` };

    // Same duplicate-PO policy as POST /orders (same customer, case-insensitive). Checked again, under a lock, when the card is confirmed.
    const dupePo = await prisma.order.findFirst({
      where: { customerId: customer.id, poNumber: { equals: poNumber, mode: "insensitive" } },
      select: { orderNumber: true },
    });
    if (dupePo) {
      return { error: agentDuplicatePoMessage(poNumber, dupePo.orderNumber, canOverrideDuplicatePo(auth.roleKey), customer.name) };
    }

    const preview = {
      customer: customer.name,
      product: `${product.name} (${product.model})`,
      quantity,
      recdSerials: serialCheck.serials,
      poNumber,
      poDate: poDateStr,
      value: value ?? null,
      orderDate: orderDateStr,
      promisedDeliveryDate: promisedDeliveryDateStr,
      plannedExhaustHookupType,
    };

    const pending = await prisma.agentPendingAction.create({
      data: {
        conversationId: auth.conversationId,
        toolName: "create_order",
        input: {
          customerId: customer.id,
          productId: product.id,
          quantity,
          recdSerials: serialCheck.serials,
          poNumber,
          poDate: poDateStr,
          value,
          orderDate: orderDateStr,
          promisedDeliveryDate: promisedDeliveryDateStr,
          plannedExhaustHookupType,
        },
        preview,
        createdById: auth.userId,
      },
    });

    return {
      status: "pending_confirmation",
      actionId: pending.id,
      preview,
      note: "Prepared for review - waiting for the user to confirm or reject in the chat UI. No order number exists yet - do not quote one or say it has been created.",
    };
  },
};

const createProductTool: AgentTool = {
  name: "create_product",
  description:
    "Propose a new RECD product model to the catalog. This does NOT create it immediately - " +
    "it prepares it and shows the user a confirm card in the chat; only THEY can approve it " +
    "by clicking Confirm. After calling this, tell the user you've prepared it for their " +
    "review - never say it has been added yet.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Product name, e.g. 'RECD 750 KVA'." },
      model: { type: "string", description: "Unique model code, e.g. 'RECD-750'." },
      ratingSpec: { type: "string", description: "Free-text rating spec, if known." },
      capacityKva: { type: "number", description: "Capacity in kVA, if known." },
      warrantyMonths: { type: "number", description: "Warranty period in months, if known." },
      shape: { type: "string", enum: ["cylinder", "triangle", "rectangle"], description: "Physical shape, if known." },
      dimensions: { type: "string", description: "Free-text dimensions, e.g. '1200 x 600 x 900 mm', if known." },
      weightKg: { type: "number", description: "Weight in kg, if known." },
    },
    required: ["name", "model"],
  },
  handler: async (input, auth) => {
    if (!auth.permissions.has(PERMISSION_KEY.MANAGE_ORDERS)) return forbidden("products");
    if (!auth.conversationId) return { error: "No active conversation - cannot propose a write action here." };

    const name = String(input.name ?? "").trim();
    const model = String(input.model ?? "").trim();
    const ratingSpec = input.ratingSpec ? String(input.ratingSpec).trim() : null;
    const capacityKva = input.capacityKva !== undefined ? Number(input.capacityKva) : null;
    const warrantyMonths = input.warrantyMonths !== undefined ? Number(input.warrantyMonths) : null;
    const shape = input.shape ? String(input.shape) : null;
    const dimensions = input.dimensions ? String(input.dimensions).trim() : null;
    const weightKg = input.weightKg !== undefined ? Number(input.weightKg) : null;

    if (!name) return { error: "name is required." };
    if (!model) return { error: "model is required." };

    const existing = await prisma.product.findUnique({ where: { model } });
    if (existing) return { error: `A product with model "${model}" already exists (${existing.name}, id: ${existing.id}) - use that one instead of creating a duplicate.` };

    const preview = { name, model, ratingSpec, capacityKva, warrantyMonths, shape, dimensions, weightKg };

    const pending = await prisma.agentPendingAction.create({
      data: {
        conversationId: auth.conversationId,
        toolName: "create_product",
        input: preview,
        preview,
        createdById: auth.userId,
      },
    });

    return {
      status: "pending_confirmation",
      actionId: pending.id,
      preview,
      note: "Prepared for review - waiting for the user to confirm or reject in the chat UI. Do not tell the user it has been added yet.",
    };
  },
};

export const appWriteTools: AgentTool[] = [createOrderTool, createProductTool];
