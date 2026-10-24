/**
 * Client-side mirror of the ticket rules for the Update form (the API enforces every one of them - this only avoids a round trip and explains
 * the rule up front). The rules themselves live in packages/shared/src/ticketPolicy.ts.
 */
import {
  COMPLAINT_STATUS,
  CLOSED_TICKET_READ_ONLY,
  REOPEN_REASON_REQUIRED,
  RESOLUTION_NOTES_REQUIRED,
  allowedNextStatuses,
  isMeaningfulResolutionNotes,
  isValidReopenReason,
} from "@recd/shared";

export interface TicketFormState {
  status: string;
  resolutionNotes: string;
  reopenReason: string;
}

/** Statuses the Status box offers: the current one plus those the workflow allows next (a non-manager cannot close or reopen). */
export function statusChoices(fromStatus: string, canManage: boolean): { value: string; disabled: boolean }[] {
  const next = new Set(allowedNextStatuses(fromStatus));
  const all = Object.values(COMPLAINT_STATUS) as string[];
  return all
    .filter((s) => s === fromStatus || next.has(s))
    .map((s) => ({
      value: s,
      disabled: s !== fromStatus && !canManage && (s === COMPLAINT_STATUS.CLOSED || fromStatus === COMPLAINT_STATUS.CLOSED),
    }));
}

/** A closed ticket is read-only for anyone who cannot manage tickets. */
export const isReadOnlyForUser = (status: string, canManage: boolean) => status === COMPLAINT_STATUS.CLOSED && !canManage;

/** null = the form may be sent; otherwise the message to show (same wording as the API). */
export function ticketFormProblem(fromStatus: string, f: TicketFormState, canManage: boolean, savedResolutionNotes: string | null): string | null {
  if (isReadOnlyForUser(fromStatus, canManage)) return CLOSED_TICKET_READ_ONLY;
  if (fromStatus === COMPLAINT_STATUS.CLOSED && f.status !== COMPLAINT_STATUS.CLOSED && !isValidReopenReason(f.reopenReason)) return REOPEN_REASON_REQUIRED;
  if (f.status === COMPLAINT_STATUS.RESOLVED && fromStatus !== COMPLAINT_STATUS.RESOLVED && !isMeaningfulResolutionNotes(f.resolutionNotes || savedResolutionNotes)) return RESOLUTION_NOTES_REQUIRED;
  return null;
}
