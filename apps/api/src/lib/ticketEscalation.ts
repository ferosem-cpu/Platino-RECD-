/**
 * Ticket-age SLA escalation (Requirement 11): the daily sweep, now retryable. The windows and the pause rules are UNCHANGED (lib/sla.ts:
 * 24 h Regional Manager, 48 h Management, measured from creation; resolved / closed / waiting_for_customer do not escalate).
 *
 * What changed is when an escalation LEVEL counts as done. Before, the level was claimed first and the messages sent afterwards, so a failed
 * or empty delivery still consumed the level and was never retried. Now, for each level a ticket has earned:
 *  1. the recipients are resolved (ticketNotify.ts - unchanged audiences); NONE -> the level is NOT advanced and the outcome is recorded;
 *  2. each recipient has a ledger row (TicketEscalationDelivery). The attempt is claimed with a conditional update BEFORE sending, so
 *     overlapping runs cannot both send; only an e-mail the provider ACCEPTED counts as delivered; a recipient already delivered that level is
 *     never sent it again; a failed one is retried (after an hour, up to 5 times, then once a day);
 *  3. only when EVERY current recipient has been delivered does the ticket's level advance - in one transaction with its ESCALATED history
 *     event, and only if the ticket still has the level we saw and is not in a paused status;
 *  4. otherwise the level stays where it was, an ESCALATION_FAILED history event says why (once per reason, not once per run), and the next
 *     run retries. A ticket that is paused / closed / reopened in the meantime is simply no longer a candidate.
 * Delivery here means the e-mail channel; the in-app record is written on the first attempt only (so retries never repeat it).
 */
import { COMPLAINT_EVENT, SLA_PAUSED_STATUSES } from "@recd/shared";
import { prisma } from "./prisma";
import { slaFromSettings, targetEscalationLevel } from "./sla";
import { logComplaintEvent, logComplaintEventStrict } from "./ticketEvents";
import { regionalManagerGap, ticketRecipients } from "./ticketNotify";
import { send as sendNotification } from "../services/notifications/notificationService";

export const ESCALATION_MAX_ATTEMPTS = 5;
export const ESCALATION_RETRY_AFTER_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export interface EscalationSummary {
  checked: number;
  escalatedToRegional: number;
  escalatedToManagement: number;
  /** levels not advanced this run because nobody could be told (no recipient / every attempt failed) - they are retried next run */
  deferred: number;
}

const audienceOf = (level: number) => (level === 1 ? "regional" : "management");

/** Records WHY a level was not advanced - once per (ticket, level, reason), so a daily retry does not flood the history. */
async function recordDeferred(ticketId: string, level: number, reason: "no_recipient" | "delivery_failed", failedRecipients: number) {
  try {
    const last = await prisma.complaintEvent.findFirst({ where: { complaintId: ticketId, type: COMPLAINT_EVENT.ESCALATION_FAILED }, orderBy: { createdAt: "desc" } });
    const lastDetail = (last?.detail ?? null) as { reason?: string } | null;
    if (last && last.toValue === String(level) && lastDetail?.reason === reason) return;
    await logComplaintEvent({
      complaintId: ticketId,
      type: COMPLAINT_EVENT.ESCALATION_FAILED,
      fromValue: String(level - 1),
      toValue: String(level),
      actorLabel: "System (SLA)",
      detail: { audience: audienceOf(level), reason, failedRecipients },
    });
  } catch (err) {
    console.error("Failed to record escalation outcome", err);
  }
}

export async function runTicketEscalation(now: Date = new Date()): Promise<EscalationSummary> {
  const sla = slaFromSettings(await prisma.companySettings.findUnique({ where: { id: "singleton" } }));
  const cutoff = new Date(now.getTime() - sla.regionalManagerHours * 3_600_000);

  const candidates = await prisma.complaint.findMany({
    where: { status: { notIn: SLA_PAUSED_STATUSES }, slaEscalationLevel: { lt: 2 }, createdAt: { lte: cutoff }, archivedAt: null },
    include: { site: { select: { regionId: true } }, unit: { select: { serialNo: true } }, customer: { select: { name: true } } },
  });

  const summary: EscalationSummary = { checked: candidates.length, escalatedToRegional: 0, escalatedToManagement: 0, deferred: 0 };
  const retryStale = new Date(now.getTime() - ESCALATION_RETRY_AFTER_MS);
  const repeatStale = new Date(now.getTime() - DAY_MS);

  for (const c of candidates) {
   // One ticket failing (a database or provider error) must never stop the escalation of the unrelated tickets after it; it is retried next run.
   try {
    const target = targetEscalationLevel(c, sla, now);
    if (target <= c.slaEscalationLevel) continue;
    const ageHours = Math.floor((now.getTime() - c.createdAt.getTime()) / 3_600_000);
    const base = { ticketNumber: c.ticketNumber, customerName: c.customer.name, serialNo: c.unit?.serialNo ?? null, status: c.status, ageHours };

    // A level jump (the job was down) still tells every audience it skipped, one level at a time.
    for (let lvl = c.slaEscalationLevel + 1; lvl <= target; lvl++) {
      const recipients = await ticketRecipients(audienceOf(lvl), { regionId: c.site?.regionId });
      // Level 1 goes to the region's Regional Managers; with no region / no manager it falls back to the Service Managers (approved) - say so in the history.
      const fallback = lvl === 1 ? await regionalManagerGap(c.site?.regionId) : null;
      if (recipients.length === 0) {
        await recordDeferred(c.id, lvl, "no_recipient", 0);
        summary.deferred++;
        break;
      }

      await prisma.ticketEscalationDelivery.createMany({ data: recipients.map((recipientId) => ({ complaintId: c.id, level: lvl, recipientId })), skipDuplicates: true });
      for (const recipientId of recipients) {
        const key = { complaintId: c.id, level: lvl, recipientId };
        const claim = await prisma.ticketEscalationDelivery.updateMany({
          where: {
            ...key,
            deliveredAt: null,
            AND: [
              { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: retryStale } }] },
              { OR: [{ attempts: { lt: ESCALATION_MAX_ATTEMPTS } }, { lastAttemptAt: { lte: repeatStale } }] },
            ],
          },
          data: { lastAttemptAt: now },
        });
        if (claim.count !== 1) continue; // already delivered, backing off, or another run took it
        const firstAttempt = (await prisma.ticketEscalationDelivery.findFirst({ where: { ...key }, select: { attempts: true } }))?.attempts === 0;
        let delivered = false;
        try {
          const logs = await sendNotification({
            recipientId,
            templateKey: "complaint_escalated",
            data: { ...base, level: lvl, audience: audienceOf(lvl) },
            channels: firstAttempt ? ["in_app", "email"] : ["email"],
          });
          delivered = logs.some((l) => l.channel === "email" && l.status === "sent");
        } catch (err) {
          console.error("Escalation notification failed", err);
        }
        if (delivered) await prisma.ticketEscalationDelivery.updateMany({ where: key, data: { deliveredAt: now, attempts: 0 } });
        else await prisma.ticketEscalationDelivery.updateMany({ where: key, data: { attempts: { increment: 1 } } });
      }

      const rows = await prisma.ticketEscalationDelivery.findMany({ where: { complaintId: c.id, level: lvl, recipientId: { in: recipients } }, select: { deliveredAt: true } });
      const undelivered = recipients.length - rows.filter((r) => r.deliveredAt).length;
      if (undelivered > 0) {
        await recordDeferred(c.id, lvl, "delivery_failed", undelivered);
        summary.deferred++;
        break;
      }

      // Everyone was told: advance the level, with its history row, in one transaction - only if the ticket is still where we saw it.
      const advanced = await prisma.$transaction(async (tx) => {
        const claimed = await tx.complaint.updateMany({
          where: { id: c.id, slaEscalationLevel: lvl - 1, status: { notIn: SLA_PAUSED_STATUSES } },
          data: { slaEscalationLevel: lvl, lastEscalatedAt: now },
        });
        if (claimed.count !== 1) return false;
        await logComplaintEventStrict(tx, {
          complaintId: c.id,
          type: COMPLAINT_EVENT.ESCALATED,
          fromValue: String(lvl - 1),
          toValue: String(lvl),
          actorLabel: "System (SLA)",
          detail: { audience: audienceOf(lvl), ageHours, recipients: recipients.length, ...(fallback ? { fallback: "service_managers", reason: fallback } : {}) },
        });
        return true;
      });
      if (!advanced) break;
      if (lvl === 1) summary.escalatedToRegional++;
      else summary.escalatedToManagement++;
    }
   } catch (err) {
    console.error(`Escalation of ticket ${c.ticketNumber} failed`, err);
    summary.deferred++;
   }
  }
  return summary;
}
