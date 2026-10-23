import { RECD_UNIT_STATUS } from "./constants";

/**
 * How the clients (the mobile app today) show a RECD unit's serial number and a contact person's mobile number. Both are nullable
 * in the database on purpose (legacy records), so a missing value always gets one standard wording - and no other person's number or
 * another unit's serial is ever substituted. These helpers only FORMAT what the API already returned for the signed-in user; they
 * grant nothing (the API decides who may read a site, an order or a contact).
 */
export const NO_MOBILE_LABEL = "No mobile number on file";
export const SERIAL_MISSING_LABEL = "Serial not entered";

const clean = (v: string | null | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The number as stored, or the standard "no number" text. */
export function mobileOrNone(phone: string | null | undefined): string {
  return clean(phone) ?? NO_MOBILE_LABEL;
}

/** The serial as stored, or the standard "serial not entered" text (a legacy unit awaiting its serial). */
export function serialOrPending(serialNo: string | null | undefined): string {
  return clean(serialNo) ?? SERIAL_MISSING_LABEL;
}

export interface UnitForDisplay {
  id: string;
  serialNo: string | null;
  status?: string;
  product?: { name: string; model: string } | null;
}

export interface UnitLine {
  id: string;
  /** The serial, or SERIAL_MISSING_LABEL. */
  serial: string;
  hasSerial: boolean;
  /** "Name (model)" when the API sent the product, else null. */
  model: string | null;
  retired: boolean;
}

/** One line per unit, in the order given. Tolerates a missing list (an older response) and legacy units without a serial. */
export function unitLines(units: readonly UnitForDisplay[] | null | undefined): UnitLine[] {
  return (units ?? []).map((u) => ({
    id: u.id,
    serial: serialOrPending(u.serialNo),
    hasSerial: clean(u.serialNo) !== null,
    model: u.product ? `${u.product.name} (${u.product.model})` : null,
    retired: u.status !== undefined && u.status !== RECD_UNIT_STATUS.ACTIVE,
  }));
}

/** "SN-1, SN-2" for a list row; the standard text for a unit without a serial; "No RECD recorded" for none at all. */
export function unitSerialsSummary(units: readonly UnitForDisplay[] | null | undefined): string {
  const lines = unitLines(units);
  if (lines.length === 0) return "No RECD recorded";
  return lines.map((l) => l.serial).join(", ");
}

export interface SiteContactSource {
  sitePocName?: string | null;
  sitePocNumber?: string | null;
  contacts?: ReadonlyArray<{ id: string; name: string; role?: string | null; phone?: string | null }> | null;
}

export interface ContactLine {
  key: string;
  /** Which record the person comes from - these are different people. */
  heading: string;
  name: string;
  phone: string;
  hasPhone: boolean;
}

/**
 * The people at a site, each tagged with the record they come from: the Site POC entered on the site, then the site's own contact
 * rows. A person without a number says so; nobody else's number is shown in their place. Empty when the site has neither.
 */
export function siteContactLines(site: SiteContactSource | null | undefined): ContactLine[] {
  if (!site) return [];
  const lines: ContactLine[] = [];
  const pocName = clean(site.sitePocName);
  const pocPhone = clean(site.sitePocNumber);
  if (pocName || pocPhone) {
    lines.push({ key: "site-poc", heading: "Site POC", name: pocName ?? "Name not on file", phone: mobileOrNone(pocPhone), hasPhone: pocPhone !== null });
  }
  for (const c of site.contacts ?? []) {
    const phone = clean(c.phone);
    const role = clean(c.role);
    lines.push({ key: `contact-${c.id}`, heading: role ? `Site contact · ${role}` : "Site contact", name: clean(c.name) ?? "Name not on file", phone: mobileOrNone(phone), hasPhone: phone !== null });
  }
  return lines;
}

/** The target for a "call" button: digits (and a leading +) only, so stored formatting can never inject anything into the link. */
export function telHref(phone: string | null | undefined): string | null {
  const p = clean(phone);
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, "");
  return /^\+?\d{6,15}$/.test(digits) ? `tel:${digits}` : null;
}
