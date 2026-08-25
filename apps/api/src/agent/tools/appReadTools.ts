/** Read-only application data tools for the in-app agent (see HANDOVER.md §24).
 * Each tool mirrors the permission logic of the equivalent REST route (see apps/api/src/routes)
 * rather than re-deriving it, and returns lightweight summaries. All money fields are returned
 * as plain numbers (2dp) for the LLM to reason over; nothing here writes back to the DB, so
 * Decimal precision loss is safe.
 */
import { Prisma } from "@prisma/client";
import { PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../../lib/prisma";
import type { AgentTool, AgentAuthContext } from "./types";

const RESULT_LIMIT = 15;

function forbidden(what: string) {
  return { error: `You don't have permission to view ${what}.` };
}

function hasAny(auth: AgentAuthContext, keys: string[]): boolean {
  return keys.some((k) => auth.permissions.has(k));
}

function num(d: Prisma.Decimal | null | undefined): number | null {
  return d == null ? null : Number(d);
}

const searchCustomers: AgentTool = {
  name: "search_customers",
  description:
    "Search customers by name. Returns id, name, address, and contact person(s). Use " +
    "this to resolve a customer name to an id before looking up their orders or complaints.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Name (or partial name) to search for." } },
  },
  handler: async (input, auth) => {
    if (!hasAny(auth, [PERMISSION_KEY.MANAGE_ORDERS])) return forbidden("customers");
    const query = input.query ? String(input.query) : undefined;
    const customers = await prisma.customer.findMany({
      where: query ? { name: { contains: query, mode: "insensitive" } } : undefined,
      include: { contacts: { select: { name: true, phone: true, email: true } } },
      orderBy: { name: "asc" },
      take: RESULT_LIMIT,
    });
    return customers.map((c) => ({
      id: c.id, name: c.name, address: c.address,
      contacts: c.contacts,
    }));
  },
};

const searchVendors: AgentTool = {
  name: "search_vendors",
  description:
    "Search external erection-subcontractor vendors by name. Returns id, name, status " +
    "(pending/approved/rejected), contact details, and how many sites/members they have.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Name (or partial name) to search for." },
      status: { type: "string", description: "Optional filter: pending | approved | rejected" },
    },
  },
  handler: async (input, auth) => {
    if (!auth.permissions.has(PERMISSION_KEY.MANAGE_VENDORS)) return forbidden("vendors");
    const query = input.query ? String(input.query) : undefined;
    const status = input.status ? String(input.status) : undefined;
    const vendors = await prisma.vendor.findMany({
      where: {
        ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
        ...(status ? { status } : {}),
      },
      include: { _count: { select: { members: true, sites: true } } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      take: RESULT_LIMIT,
    });
    return vendors.map((v) => ({
      id: v.id, name: v.name, status: v.status, contactName: v.contactName,
      contactEmail: v.contactEmail, contactPhone: v.contactPhone, address: v.address,
      memberCount: v._count.members, siteCount: v._count.sites, approvedAt: v.approvedAt,
    }));
  },
};

const searchOrdersAndSites: AgentTool = {
  name: "search_orders_and_sites",
  description:
    "Search sales orders (and their site's SITC progress) by order number, customer name, " +
    "site/end-client company name (e.g. 'BPCL', 'VRL'), site address/location (e.g. " +
    "'Belgaum', 'Bangalore'), or product name/model/rating (e.g. 'RECD-500', '500', " +
    "'500 KVA') - matches any of these, not just order number or customer. When answering a " +
    "'how many <rating> RECD are available' question, sum the quantity field plus every " +
    "additionalLineItems quantity across all matching results yourself - there's no single " +
    "pre-aggregated total field. " +
    "Returns id, orderNumber, customer, product, quantity, additionalLineItems (extra products " +
    "on the same order, if any - an order can carry more than one RECD/product), order value, " +
    "dispatch dates, and - if a site exists - its address, end-client company name, current " +
    "SITC stage, assigned engineer, and erection vendor. When answering 'how many RECDs/units " +
    "at <site>', always add the base quantity to every additionalLineItems quantity - a single " +
    "site can have multiple RECDs on one order. Use this for any 'how many/which sites are in " +
    "<place>' question - there's no separate stock/inventory-by-location feature, so this " +
    "order/site list is the closest thing to it. When called by a customer, this is " +
    "automatically scoped to only " +
    "their own orders/sites - they can search within their own records but never see anyone " +
    "else's, and searching for another company's name simply returns no results.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Order number, customer name, site company name, or site address/location (partial match)." } },
  },
  handler: async (input, auth) => {
    const query = input.query ? String(input.query) : undefined;
    const searchClauses: Prisma.OrderWhereInput = query
      ? {
          OR: [
            { orderNumber: { contains: query, mode: "insensitive" } },
            { customer: { name: { contains: query, mode: "insensitive" } } },
            { site: { is: { address: { contains: query, mode: "insensitive" } } } },
            { site: { is: { companyName: { contains: query, mode: "insensitive" } } } },
            { product: { is: { name: { contains: query, mode: "insensitive" } } } },
            { product: { is: { model: { contains: query, mode: "insensitive" } } } },
            { product: { is: { ratingSpec: { contains: query, mode: "insensitive" } } } },
            { lineItems: { some: { product: { is: { name: { contains: query, mode: "insensitive" } } } } } },
            { lineItems: { some: { product: { is: { model: { contains: query, mode: "insensitive" } } } } } },
            { lineItems: { some: { product: { is: { ratingSpec: { contains: query, mode: "insensitive" } } } } } },
          ],
        }
      : {};

    let where: Prisma.OrderWhereInput;
    if (auth.customerId) {
      // A customer's own id comes from their authenticated session (middleware/auth.ts), never
      // from tool input, so this scoping can't be bypassed by anything the model or user types.
      if (!auth.permissions.has(PERMISSION_KEY.VIEW_SITE_STATUS)) return forbidden("your sites");
      where = { AND: [{ customerId: auth.customerId }, searchClauses] };
    } else {
      if (!auth.permissions.has(PERMISSION_KEY.MANAGE_ORDERS)) return forbidden("orders");
      where = searchClauses;
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        customer: { select: { name: true } },
        product: { select: { name: true, model: true } },
        lineItems: { include: { product: { select: { name: true, model: true } } } },
        site: { include: { currentStage: true, assignedEngineer: { select: { name: true } }, vendor: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: RESULT_LIMIT,
    });
    return orders.map((o) => ({
      id: o.id, orderNumber: o.orderNumber, customer: o.customer.name,
      product: `${o.product.name} (${o.product.model})`, quantity: o.quantity,
      additionalLineItems: o.lineItems.map((li) => ({
        product: `${li.product.name} (${li.product.model})`, quantity: li.quantity,
      })),
      value: num(o.value),
      orderDate: o.orderDate, promisedDeliveryDate: o.promisedDeliveryDate, actualDispatchDate: o.actualDispatchDate,
      site: o.site
        ? {
            id: o.site.id,
            address: o.site.address,
            companyName: o.site.companyName,
            currentStage: o.site.currentStage.label,
            assignedEngineer: o.site.assignedEngineer?.name ?? null,
            vendor: o.site.vendor?.name ?? null,
          }
        : null,
    }));
  },
};

const searchComplaints: AgentTool = {
  name: "search_complaints",
  description:
    "Search customer complaints by ticket number or customer name. Returns id, ticketNumber, " +
    "customer, category, severity, status, assignedTo.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Ticket number or customer name (partial match)." },
      status: { type: "string", description: "Optional filter: open | in_progress | resolved | closed (see COMPLAINT_STATUS)" },
    },
  },
  handler: async (input, auth) => {
    if (
      !hasAny(auth, [
        PERMISSION_KEY.MANAGE_COMPLAINTS,
        PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW,
        PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS,
      ])
    )
      return forbidden("complaints");
    const query = input.query ? String(input.query) : undefined;
    const status = input.status ? String(input.status) : undefined;
    const where: Record<string, unknown> = {};
    if (!auth.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) && !auth.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW)) {
      where.assignedToId = auth.userId;
    }
    if (status) where.status = status;
    if (query) where.OR = [{ ticketNumber: { contains: query, mode: "insensitive" } }, { customer: { name: { contains: query, mode: "insensitive" } } }];
    const complaints = await prisma.complaint.findMany({
      where,
      include: { customer: { select: { name: true } }, assignedTo: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: RESULT_LIMIT,
    });
    return complaints.map((c) => ({
      id: c.id, ticketNumber: c.ticketNumber, customer: c.customer.name, category: c.category,
      severity: c.severity, status: c.status, assignedTo: c.assignedTo?.name ?? null,
    }));
  },
};

// Read-only. The upstream fork's quotation/invoice/PO/expense/saved-item/customer-pricing/
// work-order tools are finance-module features and were not ported, and neither were the
// write tools (they depend on an AgentPendingAction confirm-gate built for finance).
export const appReadTools: AgentTool[] = [
  searchCustomers,
  searchVendors,
  searchOrdersAndSites,
  searchComplaints,
];
