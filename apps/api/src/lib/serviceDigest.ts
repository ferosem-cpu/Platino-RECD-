/**
 * Region-wise Service Manager daily digest (HANDOVER section 27, roadmap item 1): ONE e-mail per recipient per region per day listing
 * the region's open tickets and which of them are overdue. It is an addition to the reminder cron - it does not touch the reminder
 * policy, the reminder tables, the 24 h / 48 h SLA escalation or any schedule.
 *
 * - OFF unless SERVICE_DIGEST_ENABLED=1 (nothing is sent to anyone until the owner switches it on).
 * - Recipients: the same people the first reminder goes to (firstLineRecipients: the region's active Service Managers, else its
 *   active Regional Managers). A region with nobody mapped, or with no open tickets, gets nothing.
 * - Open = not resolved / closed / archived. Overdue = has a due date (Complaint.dueDate) whose calendar day has passed.
 * - At most one digest per recipient + region per UTC day, checked against the notification log (only an e-mail the provider
 *   ACCEPTED counts), so a second run the same day does not repeat it and a failed one is retried by the next run.
 * - A failure here never throws into the caller; it is logged and counted.
 */
import { TICKET_FINISHED_STATUSES } from "@recd/shared";
import { prisma } from "./prisma";
import { firstLineRecipients } from "./reminders";
import { send as sendNotification } from "../services/notifications/notificationService";

export const DIGEST_TEMPLATE = "service_digest";
const MAX_LISTED = 15;

export interface DigestResult {
  enabled: boolean;
  regions: number;
  sent: number;
  skippedAlreadySent: number;
  failed: number;
}

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function runServiceDigest(now: Date = new Date()): Promise<DigestResult> {
  const result: DigestResult = { enabled: process.env.SERVICE_DIGEST_ENABLED === "1", regions: 0, sent: 0, skippedAlreadySent: 0, failed: 0 };
  if (!result.enabled) return result;
  const today = dayStart(now);

  const regions = await prisma.region.findMany({ select: { id: true, name: true } });
  for (const region of regions) {
    try {
      const tickets = await prisma.complaint.findMany({
        where: { status: { notIn: TICKET_FINISHED_STATUSES }, archivedAt: null, site: { regionId: region.id } },
        select: { ticketNumber: true, status: true, createdAt: true, dueDate: true, customer: { select: { name: true } }, site: { select: { companyName: true } }, unit: { select: { serialNo: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (tickets.length === 0) continue;
      const recipients = await firstLineRecipients(region.id);
      if (recipients.ids.length === 0) continue;
      result.regions++;

      const overdue = tickets.filter((t) => t.dueDate && t.dueDate < today);
      const listed = [...overdue, ...tickets.filter((t) => !overdue.includes(t))].slice(0, MAX_LISTED).map((t) => ({
        ticketNumber: t.ticketNumber,
        customerName: t.customer.name,
        siteName: t.site?.companyName ?? null,
        serialNo: t.unit?.serialNo ?? null,
        status: t.status,
        dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
        overdue: !!t.dueDate && t.dueDate < today,
        openDays: Math.floor((now.getTime() - t.createdAt.getTime()) / 86_400_000),
      }));
      const data = { regionName: region.name, regionId: region.id, openCount: tickets.length, overdueCount: overdue.length, tickets: listed, listedCount: listed.length };

      for (const recipientId of recipients.ids) {
        const already = await prisma.notificationLog.findFirst({
          where: { recipientId, templateKey: DIGEST_TEMPLATE, channel: "email", status: "sent", createdAt: { gte: today }, payload: { path: ["regionId"], equals: region.id } },
          select: { id: true },
        });
        if (already) {
          result.skippedAlreadySent++;
          continue;
        }
        try {
          const logs = await sendNotification({ recipientId, templateKey: DIGEST_TEMPLATE, data, channels: ["email"] });
          if (logs.some((l) => l.channel === "email" && l.status === "sent")) result.sent++;
          else result.failed++;
        } catch (err) {
          console.error("Service digest send failed", err);
          result.failed++;
        }
      }
    } catch (err) {
      console.error("Service digest failed for region", region.id, err);
      result.failed++;
    }
  }
  return result;
}
