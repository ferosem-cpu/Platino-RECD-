/** Shown wherever a contact person has no mobile number on file - never another person's number. */
export const NO_MOBILE_LABEL = "No mobile number on file";

/** The number as stored, or the standard "no number" text. */
export function mobileOrNone(phone: string | null | undefined): string {
  return phone && phone.trim() ? phone.trim() : NO_MOBILE_LABEL;
}

/** "Name · number" for a contact person, with the standard text when that person has no number. */
export function nameWithMobile(name: string, phone: string | null | undefined): string {
  return `${name} · ${mobileOrNone(phone)}`;
}

/** "email · number" line under a vendor's contact name; only the vendor's own number is ever used. */
export function emailWithMobile(email: string, phone: string | null | undefined): string {
  return `${email} · ${mobileOrNone(phone)}`;
}

/** Shape of `contactInfo` on each ticket from GET /complaints (apps/api/src/lib/ticketContacts.ts). */
export interface TicketContactInfo {
  reporter: { name: string | null; type: string | null; phone: string | null } | null;
  sitePoc: { name: string | null; phone: string | null } | null;
  siteContacts: Array<{ id: string; name: string; role: string | null; phone: string | null }>;
  customerContact: { name: string; phone: string | null } | null;
}

export interface ContactRow {
  /** Which record the person comes from - these are different people. */
  kind: "reporter" | "sitePoc" | "siteContact" | "customerContact";
  heading: string;
  name: string;
  phone: string;
  hasPhone: boolean;
}

/** The rows the ticket screen shows, in a fixed order, each tagged with where it came from. */
export function ticketContactRows(info: TicketContactInfo | undefined | null): ContactRow[] {
  if (!info) return [];
  const rows: ContactRow[] = [];
  const add = (kind: ContactRow["kind"], heading: string, name: string | null, phone: string | null) =>
    rows.push({ kind, heading, name: name?.trim() || "Name not on file", phone: mobileOrNone(phone), hasPhone: !!(phone && phone.trim()) });

  if (info.reporter) {
    const type = info.reporter.type ? ` (${info.reporter.type.replace(/_/g, " ")})` : "";
    add("reporter", `Reported by${type}`, info.reporter.name, info.reporter.phone);
  }
  if (info.sitePoc) add("sitePoc", "Site POC", info.sitePoc.name, info.sitePoc.phone);
  for (const c of info.siteContacts) add("siteContact", c.role ? `Site contact · ${c.role}` : "Site contact", c.name, c.phone);
  if (info.customerContact) add("customerContact", "Customer contact", info.customerContact.name, info.customerContact.phone);
  return rows;
}
