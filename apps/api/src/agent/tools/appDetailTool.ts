/** Full-detail drill-down for one specific document, given the id returned by one of the
 * appReadTools search_* tools. Kept as one dispatched tool (rather than one per docType)
 * so the agent only has to remember one shape: docType + id.
 */
import { PERMISSION_KEY } from "@recd/shared";
import { prisma } from "../../lib/prisma";
import type { AgentTool, AgentAuthContext } from "./types";

// No quotation/invoice/purchase_order/expense/work_order here - those are finance-module
// records that this app does not have (see HANDOVER.md §24).
const DOC_TYPES = ["customer", "vendor", "order", "complaint"] as const;
type DocType = (typeof DOC_TYPES)[number];

function forbidden(what: string) {
  return { error: `You don't have permission to view ${what}.` };
}

async function loadDetail(docType: DocType, id: string, auth: AgentAuthContext) {
  switch (docType) {
    case "customer":
      if (!auth.permissions.has(PERMISSION_KEY.MANAGE_ORDERS)) return forbidden("customers");
      return prisma.customer.findUnique({
        where: { id },
        include: {
          contacts: { select: { name: true, phone: true, email: true } },
          orders: { select: { id: true, orderNumber: true, value: true, orderDate: true } },
        },
      });
    case "vendor":
      if (!auth.permissions.has(PERMISSION_KEY.MANAGE_VENDORS)) return forbidden("vendors");
      return prisma.vendor.findUnique({
        where: { id },
        include: {
          members: { select: { name: true, phone: true, email: true } },
          sites: { include: { order: { select: { orderNumber: true } }, currentStage: true } },
        },
      });
    case "order": {
      // A customer can look up one of their OWN orders (e.g. to resolve its siteId before
      // looking up its site) with just VIEW_SITE_STATUS - staff still needs MANAGE_ORDERS,
      // unscoped. Object-level check happens after the fetch since we need the row's
      // customerId to compare against auth.customerId (which comes from the session, never
      // from tool input).
      if (auth.customerId) {
        if (!auth.permissions.has(PERMISSION_KEY.VIEW_SITE_STATUS)) return forbidden("orders");
      } else if (!auth.permissions.has(PERMISSION_KEY.MANAGE_ORDERS)) {
        return forbidden("orders");
      }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          customer: true, product: true, salesEngineer: { select: { name: true } },
          lineItems: { include: { product: true } },
          site: { include: { currentStage: true, assignedEngineer: { select: { name: true } }, vendor: true } },
        },
      });
      if (auth.customerId && order && order.customerId !== auth.customerId) return forbidden("orders");
      return order;
    }
    case "complaint":
      if (
        !auth.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) &&
        !auth.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW) &&
        !auth.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS)
      )
        return forbidden("complaints");
      return prisma.complaint.findUnique({
        where: { id },
        include: {
          customer: { select: { name: true } }, site: { select: { address: true } },
          assignedTo: { select: { name: true } },
        },
      });
  }
}

export const getDocumentDetailTool: AgentTool = {
  name: "get_document_detail",
  description:
    "Get the full detail (all line items / payments / contacts, not just a summary) of one " +
    "specific record, given its id and type. Get the id from one of the search_* tools first " +
    `(never guess an id). docType must be one of: ${DOC_TYPES.join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      docType: { type: "string", enum: [...DOC_TYPES], description: "Which kind of record this id belongs to." },
      id: { type: "string", description: "The record's id, as returned by a search_* tool." },
    },
    required: ["docType", "id"],
  },
  handler: async (input, auth) => {
    const docType = String(input.docType) as DocType;
    const id = String(input.id ?? "");
    if (!DOC_TYPES.includes(docType)) return { error: `Unknown docType. Must be one of: ${DOC_TYPES.join(", ")}.` };
    const result = await loadDetail(docType, id, auth);
    if (!result) return { error: `No ${docType} found with id ${id}.` };
    return result;
  },
};
