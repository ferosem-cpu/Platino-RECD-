import { z } from "zod";

/**
 * Service reminders (Requirement 6): explicit due dates on service activities, the pending / due-soon / overdue
 * classification, the reminder lifecycle and the policy knobs. Shared so the API, the cron job and the dashboard agree.
 *
 * NOTHING here invents a business rule: a due date only exists when a person sets it, the "due soon" window and the
 * escalation timing are policy settings that are EMPTY (= off) until the business approves values, and the ticket-age
 * SLA escalation (SLA_DEFAULTS) is a different mechanism that is left untouched.
 */

export const REMINDER_ACTIVITY = { TICKET: "ticket", AMC_VISIT: "amc_visit" } as const;
export type ReminderActivityType = (typeof REMINDER_ACTIVITY)[keyof typeof REMINDER_ACTIVITY];

export const AMC_VISIT_STATUS = { SCHEDULED: "scheduled", COMPLETED: "completed", CANCELLED: "cancelled" } as const;
export type AmcVisitStatus = (typeof AMC_VISIT_STATUS)[keyof typeof AMC_VISIT_STATUS];

/** Ticket statuses that mean the activity is done: no reminders, open reminders are closed. */
export const TICKET_FINISHED_STATUSES: string[] = ["resolved", "closed"];

export const REMINDER_STATUS = {
  /** Created, nothing sent yet. */
  PENDING: "pending",
  /** Claimed by a running job (guards against two overlapping runs). */
  SENDING: "sending",
  /** Delivered to at least one recipient. */
  SENT: "sent",
  /** Every delivery attempt failed (retried on the next run). */
  FAILED: "failed",
  /** No active manager could be found for the activity's region (retried on the next run). */
  NO_RECIPIENT: "no_recipient",
  /** A manager acknowledged it. */
  ACKNOWLEDGED: "acknowledged",
  /** The activity was completed / cancelled, so the reminder no longer applies. */
  CLOSED: "closed",
} as const;
export type ReminderStatus = (typeof REMINDER_STATUS)[keyof typeof REMINDER_STATUS];

export const REMINDER_EVENT = {
  CREATED: "created",
  /** An e-mail was ACCEPTED for this recipient - the only outcome that counts as delivered (nothing reads in-app rows). */
  SENT: "sent",
  /** An in-app NotificationLog row was written. It is a record only: no inbox shows it, so it is never "delivered". */
  IN_APP_RECORDED: "in_app_recorded",
  DELIVERY_FAILED: "delivery_failed",
  NO_RECIPIENT: "no_recipient",
  ACKNOWLEDGED: "acknowledged",
  ESCALATED: "escalated",
  ESCALATION_NO_RECIPIENT: "escalation_no_recipient",
  DUE_DATE_CHANGED: "due_date_changed",
  CLOSED: "closed",
} as const;

/** Roles that may be mapped to a region. Both use the same RegionManager table; the roles stay distinct. */
export const REGION_MAPPABLE_ROLE_KEYS = ["regional_manager", "service_manager"] as const;

/** The only reminder status a manager may acknowledge: delivered to everyone it was meant for and not yet acknowledged or closed. */
export const ACKNOWLEDGEABLE_REMINDER_STATUS = REMINDER_STATUS.SENT;

export const MAX_REMINDER_ESCALATION_LEVEL = 2;
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A reminder stuck in "sending" (the job died) can be picked up again after this long. */
export const SENDING_STALE_MINUTES = 15;

const DAY_MS = 24 * 3600 * 1000;

export type DueState = "no_due_date" | "pending" | "due_soon" | "overdue";

/**
 * The one definition of overdue, used by the dashboard and the cron job.
 *  - A due date is a calendar DATE (stored as UTC midnight). An activity is overdue once that whole day has passed.
 *  - "due soon" exists only when the policy sets a lead time (leadDays); with no lead time there is just pending / overdue.
 *  - No due date is its own state; nothing is invented for it.
 */
export function classifyDue(dueDate: Date | string | null | undefined, now: Date, leadDays: number | null | undefined): DueState {
  if (!dueDate) return "no_due_date";
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return "no_due_date";
  if (now.getTime() >= due + DAY_MS) return "overdue";
  if (leadDays != null && leadDays >= 0 && due - now.getTime() <= leadDays * DAY_MS) return "due_soon";
  return "pending";
}

/** Should a reminder exist for this activity now? Only with a due date, and only once it is due soon or overdue. */
export function reminderEligible(dueDate: Date | string | null | undefined, now: Date, leadDays: number | null | undefined): boolean {
  if (leadDays == null) return false; // policy not set: nothing is reminded
  const s = classifyDue(dueDate, now, leadDays);
  return s === "due_soon" || s === "overdue";
}

/** Is an unacknowledged reminder due for its next escalation level? */
export function escalationDue(
  r: { status: string; sentAt: Date | null; acknowledgedAt: Date | null; escalationLevel: number; lastEscalatedAt: Date | null },
  escalationHours: number | null | undefined,
  now: Date,
): boolean {
  if (escalationHours == null || escalationHours <= 0) return false;
  if (r.status !== REMINDER_STATUS.SENT || r.acknowledgedAt || !r.sentAt) return false;
  if (r.escalationLevel >= MAX_REMINDER_ESCALATION_LEVEL) return false;
  const since = r.lastEscalatedAt ?? r.sentAt;
  return now.getTime() - since.getTime() >= escalationHours * 3600 * 1000;
}

export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the due date as YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a real calendar date");

/** Set (or clear, with null) the explicit due date of a ticket. */
export const setTicketDueDateSchema = z.object({ dueDate: dueDateSchema.nullable() });

export const createAmcVisitSchema = z.object({
  amcOrderId: z.string().min(1),
  unitId: z.string().min(1),
  dueDate: dueDateSchema,
});

export const updateAmcVisitSchema = z
  .object({
    dueDate: dueDateSchema.optional(),
    status: z.enum([AMC_VISIT_STATUS.COMPLETED, AMC_VISIT_STATUS.CANCELLED]).optional(),
  })
  .refine((v) => v.dueDate !== undefined || v.status !== undefined, { message: "Nothing to change" });

/** Reminder policy. null = OFF. Nothing is sent / escalated until the business approves values. */
export const reminderPolicySchema = z.object({
  /** Send the first reminder when an activity is due within this many days (and for everything overdue). */
  reminderLeadDays: z.number().int().min(0).max(365).nullable(),
  /** Escalate a reminder nobody has acknowledged after this many hours (once per level, two levels). */
  reminderEscalationHours: z.number().int().min(1).max(24 * 60).nullable(),
});

export const REMINDER_POLICY_DEFAULTS = { reminderLeadDays: null, reminderEscalationHours: null } as const;

/**
 * The PROPOSED reminder workflow, for mentor review. It is a suggestion shown in Settings, never a default: nothing is switched on
 * until an authorised person saves these values in the environment concerned (the stored policy stays empty = off).
 *   Stage 1  first reminder  : 3 calendar days before the due date -> the region's active Service Managers
 *   Stage 2  escalation 1    : unacknowledged 24 h after the reminder was DELIVERED -> the region's Regional Managers
 *   Stage 3  escalation 2    : unacknowledged 24 h after escalation 1 was DELIVERED -> Management and Owner/Admin
 * (24 h per stage is the single `reminderEscalationHours` value.) Both clocks start at a successful delivery, never at the
 * activity's creation or due date.
 */
export const PROPOSED_REMINDER_POLICY = { reminderLeadDays: 3, reminderEscalationHours: 24 } as const;
