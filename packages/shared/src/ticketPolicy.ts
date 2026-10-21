/**
 * Ticket (Complaint) status policy (Requirement 11). The nine statuses are the existing ones (constants.ts COMPLAINT_STATUS) and keep
 * their meaning; this module only validates them and decides what a status change does to `closedAt`. One place, pure, shared by the API,
 * the web app and the tests.
 *
 * Which status may follow which is a PROPOSED workflow (see the table above isStatusTransitionAllowed): the original requirement does not
 * define it. The API answers 409 TRANSITION_NOT_ALLOWED for anything outside the table.
 */
import { z } from "zod";
import { COMPLAINT_STATUS } from "./constants";

export const COMPLAINT_STATUS_VALUES = Object.values(COMPLAINT_STATUS) as [string, ...string[]];

/** Only the nine existing statuses are accepted; anything else is a validation error (never stored). */
export const complaintStatusSchema = z.enum(COMPLAINT_STATUS_VALUES as [string, ...string[]], {
  errorMap: () => ({ message: `Status must be one of: ${COMPLAINT_STATUS_VALUES.join(", ")}` }),
});

export const isComplaintStatus = (s: unknown): s is string => typeof s === "string" && COMPLAINT_STATUS_VALUES.includes(s);

/** Statuses in which a ticket counts as finished for the one-open-ticket-per-unit rule (matches the partial unique index). */
export const TICKET_CLOSED_STATUSES: readonly string[] = [COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.CLOSED];

/**
 * STATUS TRANSITIONS (proposed workflow, 2026-10-21 - the original requirement only says "track ticket status"; this table is an ASSUMPTION
 * that the business may change HERE, in one place; the API, the web form and the tests all read it).
 *
 *   active   = open, acknowledged, assigned, in_progress, waiting_for_customer, waiting_for_part, escalated
 *   - active   -> any other active status      (work moves freely while the ticket is being handled; nothing about assignment is implied)
 *   - active   -> resolved                     (needs meaningful resolution notes - see isMeaningfulResolutionNotes)
 *   - resolved -> closed                       (final closure: a manager; see TICKET_CLOSE_PERMISSION)
 *   - resolved -> any active status            (the fix did not hold: worked again)
 *   - closed   -> any active status            (reopening: a manager, with a reason; see TICKET_REOPEN_PERMISSION)
 *   NOT allowed: active -> closed directly (an engineer resolves, a manager then closes), closed -> resolved (reopen to an active status
 *   first), and a ticket never "moves" to its own status (that is an unchanged status, not a transition).
 */
const ACTIVE_STATUSES: readonly string[] = [
  COMPLAINT_STATUS.OPEN,
  COMPLAINT_STATUS.ACKNOWLEDGED,
  COMPLAINT_STATUS.ASSIGNED,
  COMPLAINT_STATUS.IN_PROGRESS,
  COMPLAINT_STATUS.WAITING_FOR_CUSTOMER,
  COMPLAINT_STATUS.WAITING_FOR_PART,
  COMPLAINT_STATUS.ESCALATED,
];

/** The statuses a ticket may move to from `from`. */
export function allowedNextStatuses(from: string): string[] {
  if (ACTIVE_STATUSES.includes(from)) return [...ACTIVE_STATUSES.filter((s) => s !== from), COMPLAINT_STATUS.RESOLVED];
  if (from === COMPLAINT_STATUS.RESOLVED) return [...ACTIVE_STATUSES, COMPLAINT_STATUS.CLOSED];
  if (from === COMPLAINT_STATUS.CLOSED) return [...ACTIVE_STATUSES];
  return [];
}

/** The ONE place that holds the transition rules (see the table above). Staying in the same status is not a transition and is always fine. */
export function isStatusTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true;
  return allowedNextStatuses(from).includes(to);
}

/**
 * "Meaningful" resolution notes (rule, 2026-10-21): after trimming, at least 10 characters, at least 2 words, and not one character repeated.
 * Required before a ticket may ENTER resolved; once resolved / closed the notes can still be corrected but never blanked or replaced by
 * something that is not meaningful.
 */
export const RESOLUTION_NOTES_MIN_LENGTH = 10;
export const RESOLUTION_NOTES_REQUIRED = `Resolution notes are required before a ticket can be resolved: describe what was done (at least ${RESOLUTION_NOTES_MIN_LENGTH} characters, in words).`;
export function isMeaningfulResolutionNotes(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < RESOLUTION_NOTES_MIN_LENGTH) return false;
  if (t.split(/\s+/).length < 2) return false;
  return new Set(t.replace(/\s+/g, "").toLowerCase()).size > 2;
}

/** Reopening a CLOSED ticket needs a reason (trimmed, at least 10 characters, at most 1000) - recorded in the history with the actor and time. */
export const REOPEN_REASON_MIN_LENGTH = 10;
export const REOPEN_REASON_MAX_LENGTH = 1000;
export const REOPEN_REASON_REQUIRED = `Say why this closed ticket is being reopened (at least ${REOPEN_REASON_MIN_LENGTH} characters).`;
export const isValidReopenReason = (text: unknown): text is string =>
  typeof text === "string" && text.trim().length >= REOPEN_REASON_MIN_LENGTH && text.trim().length <= REOPEN_REASON_MAX_LENGTH;

export type StatusChangeKind = "unchanged" | "closed" | "reopened" | "other";

/**
 * What a status change means for the closure timestamp:
 *  - closed: moving INTO closed from any other status - `closedAt` is set (once);
 *  - reopened: moving OUT of closed - `closedAt` is cleared (the ticket is no longer closed; the history keeps the closure event);
 *  - unchanged: same status - nothing about closure is touched (a repeated closure keeps its original `closedAt`);
 *  - other: any other change.
 */
export function classifyStatusChange(from: string, to: string): StatusChangeKind {
  if (from === to) return "unchanged";
  if (to === COMPLAINT_STATUS.CLOSED) return "closed";
  if (from === COMPLAINT_STATUS.CLOSED) return "reopened";
  return "other";
}

/** The `closedAt` value a status change must write: a Date (set), null (clear) or undefined (leave alone). */
export function closedAtFor(kind: StatusChangeKind, existingClosedAt: Date | null, now: Date): Date | null | undefined {
  if (kind === "closed") return existingClosedAt ?? now;
  if (kind === "reopened") return null;
  return undefined;
}

/**
 * Who may CLOSE a ticket (business decision, 2026-10-21): an engineer RESOLVES the work; an authorised manager (a holder of manage_complaints)
 * performs the final closure. Moving a ticket INTO "closed" therefore needs this permission; every other status change (including resolved)
 * is unchanged. Likewise (decision, 2026-10-21) only a manager may REOPEN a closed ticket, i.e. move it OUT of "closed" - same permission.
 * Which status may follow which is still undecided (see isStatusTransitionAllowed).
 */
export const TICKET_CLOSE_PERMISSION = "manage_complaints";
export const TICKET_REOPEN_PERMISSION = "manage_complaints";
export const REOPEN_REQUIRES_MANAGER = "Only a ticket manager can reopen a closed ticket.";
export const CLOSED_TICKET_READ_ONLY = "This ticket is closed. Only a ticket manager can add notes to a closed ticket.";
export const CLOSE_REQUIRES_MANAGER = "Only a ticket manager can close a ticket. Mark it resolved and a manager will close it.";

/** The roles a ticket may be assigned to (same list the assignee picker has always offered). */
export const TICKET_ASSIGNEE_ROLES: readonly string[] = ["erection_engineer", "commissioning_engineer", "service_team", "service_engineer"];

/** Optional list filters of GET /complaints (all optional; absent = the previous behaviour). */
export const TICKET_LIST_LIMIT_DEFAULT = 1000;
export const TICKET_LIST_LIMIT_MAX = 500;
