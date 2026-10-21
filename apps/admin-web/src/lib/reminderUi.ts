import { MAX_DELIVERY_ATTEMPTS } from "@recd/shared";

export interface ReminderLike {
  status: string;
  statusReason: string | null;
  escalationLevel: number;
}

/** Plain-words status of a reminder. A failed or recipient-less reminder is never described as sent. */
export function reminderLabel(r: ReminderLike | null, policyOn: boolean): { text: string; cls: string } {
  if (!r) return { text: policyOn ? "No reminder yet" : "Reminders off", cls: "status-pill" };
  switch (r.status) {
    case "acknowledged": return { text: "Acknowledged", cls: "status-pill status-pill-success" };
    case "sent": return { text: r.escalationLevel > 0 ? `Sent - escalated (level ${r.escalationLevel})` : "Sent - not acknowledged", cls: r.escalationLevel > 0 ? "status-pill status-pill-error" : "status-pill status-pill-warning" };
    case "failed": return { text: r.statusReason === "partial_delivery" ? "Delivered to some managers - retrying the rest" : "Delivery failed (will retry)", cls: "status-pill status-pill-error" };
    case "no_recipient": return { text: r.statusReason === "no_region" ? "No recipient: site has no region" : "No recipient: no active manager for this region", cls: "status-pill status-pill-error" };
    case "closed": return { text: "Closed", cls: "status-pill" };
    default: return { text: "Waiting to be sent", cls: "status-pill" };
  }
}

export interface EscalationLike {
  status: string;
  escalationLevel: number;
  /** Delivery attempts of the NEXT level (the API's escalationAttempts). Absent on an older API: then nothing is claimed. */
  escalationAttempts?: number | null;
}

const LAST_LEVEL = 2;

/**
 * One plain sentence about escalation, from the values the API actually returns - or null when there is nothing to add: no
 * reminder yet, not delivered yet, closed, or a level that was simply delivered (the dashboard's "Escalated to level N" line says so). `policyHours` is the approved escalation time
 * (null = escalation is off). Wording: "attempts" are the delivery attempts of the NEXT level that did not reach everyone.
 */
export function escalationInfo(r: EscalationLike | null, policyHours: number | null, max: number = MAX_DELIVERY_ATTEMPTS): { text: string; cls: string } | null {
  if (!r || r.status === "closed") return null;
  const level = r.escalationLevel;
  const delivered = level > 0 ? `Escalation level ${level} delivered` : null;
  if (level >= LAST_LEVEL) return { text: `${delivered} - last level reached`, cls: "text-red-700" };
  const attempts = typeof r.escalationAttempts === "number" ? r.escalationAttempts : null;
  const next = level + 1;
  if (r.status === "sent" && attempts !== null && attempts >= max) {
    return { text: `${delivered ? `${delivered}. ` : ""}Escalation attempt limit reached - level ${next}: ${attempts} of ${max} attempts failed, no more retries`, cls: "text-red-700" };
  }
  if (r.status === "sent" && attempts !== null && attempts > 0) {
    return { text: `${delivered ? `${delivered}. ` : ""}Escalation retrying - level ${next}: ${attempts} of ${max} attempts failed`, cls: "text-amber-700" };
  }
  if (delivered) return null; // a delivered level is already stated by the "Escalated to level N on <date>" line
  if (r.status === "sent") return { text: policyHours == null ? "Escalation is off" : "No escalation attempted yet", cls: "text-gray-500" };
  return null;
}

/** " - attempt 3" for events that recorded their attempt number; "" for older events (nothing is invented). */
export function attemptSuffix(e: { type: string; attempt?: number | null }): string {
  const hasAttempt = ["sent", "delivery_failed", "in_app_recorded", "escalated", "escalation_no_recipient"].includes(e.type);
  return hasAttempt && typeof e.attempt === "number" && Number.isFinite(e.attempt) && e.attempt > 0 ? ` - attempt ${e.attempt}` : "";
}
