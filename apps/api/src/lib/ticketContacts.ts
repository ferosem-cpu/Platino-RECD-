import { PERMISSION_KEY } from "@recd/shared";

/**
 * Who a service ticket's contact numbers may be shown to, and where each number comes from.
 * The people are kept apart on purpose - they are not necessarily the same person:
 *
 *   reporter         Complaint.reporterName / reporterPhone  - who raised a PUBLIC ticket (verified by OTP)
 *   sitePoc          Site.sitePocName / sitePocNumber        - the person at the site
 *   siteContacts     SiteContact rows of the ticket's own site
 *   customerContact  the registered customer's primary contact (its oldest contact user)
 *
 * A missing number is \`phone: null\` so screens can say "No mobile number on file" - no other
 * person's number is ever substituted.
 */
export type ContactAudience = "none" | "field" | "desk";

export interface TicketContactInfo {
  /** Only for public-source tickets. */
  reporter: { name: string | null; type: string | null; phone: string | null } | null;
  sitePoc: { name: string | null; phone: string | null } | null;
  siteContacts: Array<{ id: string; name: string; role: string | null; phone: string | null }>;
  /** Desk roles only - field engineers do not get the customer company's login contact. */
  customerContact: { name: string; phone: string | null } | null;
}

/**
 * - customers: "none" (they know their own details; reporter numbers of third parties stay hidden)
 * - complaint managers / overview viewers (service desk, managers, Regional Managers): "desk"
 * - roles that only act on tickets assigned to them (field and vendor engineers): "field"
 * - everyone else (sales, finance, ...): "none" - they cannot list tickets at all
 */
export function contactAudience(auth: { customerId?: string | null; permissions: Set<string> }): ContactAudience {
  if (auth.customerId) return "none";
  if (auth.permissions.has(PERMISSION_KEY.MANAGE_COMPLAINTS) || auth.permissions.has(PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW)) return "desk";
  if (auth.permissions.has(PERMISSION_KEY.ACT_ASSIGNED_COMPLAINTS)) return "field";
  return "none";
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export interface TicketContactSource {
  ticket: { source?: string | null; reporterName?: string | null; reporterType?: string | null; reporterPhone?: string | null };
  /** The ticket's OWN site (loaded through the ticket's relation, never from a client-supplied id). */
  site: {
    sitePocName: string | null;
    sitePocNumber: string | null;
    contacts: Array<{ id: string; name: string; role: string | null; phone: string | null }>;
  } | null;
  /** The ticket customer's primary contact, only loaded for desk roles. */
  customerContact: { name: string; phone: string | null } | null;
}

export function buildTicketContactInfo(src: TicketContactSource, audience: ContactAudience): TicketContactInfo | undefined {
  if (audience === "none") return undefined;
  const isPublic = src.ticket.source === "public";
  const site = src.site;
  return {
    reporter: isPublic
      ? { name: clean(src.ticket.reporterName), type: clean(src.ticket.reporterType), phone: clean(src.ticket.reporterPhone) }
      : null,
    sitePoc: site && (clean(site.sitePocName) || clean(site.sitePocNumber)) ? { name: clean(site.sitePocName), phone: clean(site.sitePocNumber) } : site ? { name: null, phone: null } : null,
    siteContacts: (site?.contacts ?? []).map((c) => ({ id: c.id, name: c.name, role: clean(c.role), phone: clean(c.phone) })),
    customerContact: audience === "desk" && src.customerContact ? { name: src.customerContact.name, phone: clean(src.customerContact.phone) } : null,
  };
}
