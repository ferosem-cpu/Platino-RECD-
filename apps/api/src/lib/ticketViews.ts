/**
 * What a CUSTOMER may read about their own ticket (Requirement 11). A whitelist - a column added to Complaint later is invisible to customers
 * until it is listed here. Staff keep the full row (they need it to work the ticket).
 *
 * Shown: what the customer reported and where it stands (ticket number, category, description, severity, status, dates, their own photo, the
 * unit's serial, their own site's name / address and order number).
 * Never shown: root cause, staff remarks, resolution notes, the uploaded staff report, who the ticket is assigned to, the due date, SLA /
 * escalation progress, closure / archive actors, and the reporter details of a third party (a reseller who raised it through the public flow).
 * Resolved-work detail reaches the customer through the signed service report (its own, separately authorised endpoints).
 */
export const CUSTOMER_TICKET_SITE_SELECT = {
  id: true,
  companyName: true,
  address: true,
  order: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true } } } },
} as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function customerTicketView(c: any) {
  return {
    id: c.id,
    ticketNumber: c.ticketNumber,
    customerId: c.customerId,
    siteId: c.siteId ?? null,
    unitId: c.unitId ?? null,
    category: c.category,
    issueCategory: c.issueCategory ?? null,
    description: c.description,
    severity: c.severity,
    status: c.status,
    attachmentUrl: c.attachmentUrl ?? null,
    source: c.source,
    // The reporter's own name / type are kept (who raised it, on a public ticket) - never their phone, which is a third party's number.
    reporterName: c.reporterName ?? null,
    reporterType: c.reporterType ?? null,
    createdAt: c.createdAt,
    closedAt: c.closedAt ?? null,
    ...(c.unit !== undefined ? { unit: c.unit ? { id: c.unit.id, serialNo: c.unit.serialNo ?? null } : null } : {}),
    ...(c.site !== undefined
      ? {
          site: c.site
            ? {
                id: c.site.id,
                companyName: c.site.companyName ?? null,
                address: c.site.address ?? null,
                order: c.site.order
                  ? { id: c.site.order.id, orderNumber: c.site.order.orderNumber, customer: c.site.order.customer ? { id: c.site.order.customer.id, name: c.site.order.customer.name } : null }
                  : null,
              }
            : null,
        }
      : {}),
  };
}
