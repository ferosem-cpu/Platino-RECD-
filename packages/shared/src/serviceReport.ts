import { z } from "zod";

/**
 * Digital service report: states, transitions, limits and request schemas - shared so the API, the web screens
 * and (later) the mobile app agree on them. The API is the authority; the screens only mirror these rules.
 *
 *   draft --submit--> awaiting_signature --sign (customer)--> signed (final, immutable)
 *     ^------reopen------'
 */
export const SERVICE_REPORT_STATUS = {
  DRAFT: "draft",
  AWAITING_SIGNATURE: "awaiting_signature",
  SIGNED: "signed",
  /** Final WITHOUT a customer signature: only for AMC reports whose acknowledgement was marked "not required". */
  SUBMITTED: "submitted",
} as const;
export type ServiceReportStatus = (typeof SERVICE_REPORT_STATUS)[keyof typeof SERVICE_REPORT_STATUS];

export const SERVICE_REPORT_STATUS_LABELS: Record<ServiceReportStatus, string> = {
  draft: "Draft",
  awaiting_signature: "Awaiting customer signature",
  signed: "Signed",
  submitted: "Submitted (no signature required)",
};

/** Which kind of visit a report records. Exactly one owner: a ticket (complaint) or an AMC order. */
export const SERVICE_REPORT_KIND = { TICKET: "ticket", AMC: "amc" } as const;
export type ServiceReportKind = (typeof SERVICE_REPORT_KIND)[keyof typeof SERVICE_REPORT_KIND];

/** Statuses that are final: the content can never change again. */
export const SERVICE_REPORT_FINAL_STATUSES: ServiceReportStatus[] = ["signed", "submitted"];
/** Statuses of a report still being worked on. */
export const SERVICE_REPORT_OPEN_STATUSES: ServiceReportStatus[] = ["draft", "awaiting_signature"];

/** A signed report is final: nothing leaves it. */
export const SERVICE_REPORT_TRANSITIONS: Record<ServiceReportStatus, ServiceReportStatus[]> = {
  // draft -> submitted is only allowed when the report does not require customer acknowledgement (checked by the API).
  draft: ["awaiting_signature", "submitted"],
  awaiting_signature: ["draft", "signed"],
  signed: [],
  submitted: [],
};

export function canTransitionServiceReport(from: string, to: string): boolean {
  return (SERVICE_REPORT_TRANSITIONS as Record<string, string[]>)[from]?.includes(to) ?? false;
}

export const SERVICE_REPORT_LIMITS = {
  /** Work performed, findings, resolution, parts, remarks. */
  TEXT_MAX: 4000,
  /** A submitted report must say something real in each required section. */
  REQUIRED_TEXT_MIN: 3,
  SIGNER_NAME_MIN: 2,
  SIGNER_NAME_MAX: 80,
  /** Decoded size of the drawn signature PNG. */
  SIGNATURE_MAX_BYTES: 150_000,
  SIGNATURE_MIN_DIMENSION: 80,
  SIGNATURE_MAX_DIMENSION: 1600,
} as const;

export const SIGNATURE_DATA_URL_PREFIX = "data:image/png;base64,";

const trimmedText = z.string().trim().max(SERVICE_REPORT_LIMITS.TEXT_MAX, `Keep this under ${SERVICE_REPORT_LIMITS.TEXT_MAX} characters`);

/** YYYY-MM-DD, a real calendar date, not later than tomorrow (time-zone slack). */
export const visitDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the visit date as YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a real calendar date")
  .refine((v) => new Date(`${v}T00:00:00.000Z`).getTime() <= Date.now() + 36 * 3600 * 1000, "The visit date cannot be in the future");

/**
 * What a draft may hold. Only the visit date is needed to start; the other sections are checked when the report is
 * submitted (see serviceReportMissingFields). customerId / siteId / unitId are deliberately NOT accepted from the
 * client: the API derives them from the ticket.
 */
export const serviceReportFieldsSchema = z.object({
  visitDate: visitDateSchema,
  workPerformed: trimmedText.default(""),
  findings: trimmedText.default(""),
  resolution: trimmedText.default(""),
  partsUsed: trimmedText.optional(),
  remarks: trimmedText.optional(),
});

export const createServiceReportSchema = serviceReportFieldsSchema.extend({
  complaintId: z.string().min(1),
});

/**
 * An AMC service report (one visit to one RECD unit covered by an AMC order). Only the AMC order and the unit are
 * chosen by the client; the customer and the site are derived and checked by the API, and the serial number is
 * copied from the unit at creation time.
 *
 * `acknowledgementRequired` is the explicit, stored rule for this report: true (default) = the customer must review
 * and sign; false = staff may finalise it without a customer signature. Which AMC reports need acknowledgement is an
 * open business decision - the safe default is "required".
 */
export const createAmcServiceReportSchema = serviceReportFieldsSchema.extend({
  amcOrderId: z.string().min(1),
  unitId: z.string().min(1),
  acknowledgementRequired: z.boolean().default(true),
});

export const updateServiceReportSchema = serviceReportFieldsSchema.partial().extend({
  /** AMC reports only (refused for ticket reports): change the acknowledgement rule while still a draft. */
  acknowledgementRequired: z.boolean().optional(),
  /** The version the editor loaded; a stale edit is refused instead of overwriting newer work. */
  expectedVersion: z.number().int().positive(),
});

export const submitServiceReportSchema = z.object({ expectedVersion: z.number().int().positive() });
export const reopenServiceReportSchema = submitServiceReportSchema;

/** Longest base64 text a signature of SIGNATURE_MAX_BYTES can have (plus the data-URL prefix). */
const SIGNATURE_MAX_CHARS = SIGNATURE_DATA_URL_PREFIX.length + Math.ceil((SERVICE_REPORT_LIMITS.SIGNATURE_MAX_BYTES * 4) / 3) + 4;

export const signServiceReportSchema = z.object({
  signerName: z
    .string()
    .trim()
    .min(SERVICE_REPORT_LIMITS.SIGNER_NAME_MIN, "Type your full name")
    .max(SERVICE_REPORT_LIMITS.SIGNER_NAME_MAX),
  signatureImage: z
    .string()
    .max(SIGNATURE_MAX_CHARS, "The signature image is too large")
    .startsWith(SIGNATURE_DATA_URL_PREFIX, "The signature must be a PNG image"),
  /** The version of the report the customer reviewed. Signing a different (edited) version is refused. */
  version: z.number().int().positive(),
  /** The customer ticked "I have reviewed this report and approve it". */
  confirm: z.literal(true, { errorMap: () => ({ message: "Confirm that you have reviewed the report" }) }),
});

export interface ServiceReportContent {
  visitDate?: string | Date | null;
  workPerformed?: string | null;
  findings?: string | null;
  resolution?: string | null;
}

/** Sections that must be filled before a report can be submitted for signature. */
export function serviceReportMissingFields(r: ServiceReportContent): string[] {
  const missing: string[] = [];
  if (!r.visitDate) missing.push("Visit date");
  const need = (label: string, v: string | null | undefined) => {
    if (!v || v.trim().length < SERVICE_REPORT_LIMITS.REQUIRED_TEXT_MIN) missing.push(label);
  };
  need("Work performed", r.workPerformed);
  need("Findings", r.findings);
  need("Resolution", r.resolution);
  return missing;
}
