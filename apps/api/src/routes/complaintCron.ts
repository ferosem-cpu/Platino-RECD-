/**
 * SLA escalation sweep. Invoked by Vercel Cron (see vercel.json), which sends
 * `Authorization: Bearer $CRON_SECRET`. Mounted BEFORE the authenticated complaints router.
 *
 * An unresolved ticket older than the Regional Manager window alerts that region's managers
 * (level 1); older than the Management window it alerts Management (level 2). Levels only move
 * up and are claimed atomically, so overlapping runs never alert twice.
 */
import { Router } from "express";
import { COMPLAINT_EVENT, SLA_PAUSED_STATUSES } from "@recd/shared";
import { prisma } from "../lib/prisma";
import { slaFromSettings, targetEscalationLevel } from "../lib/sla";
import { logComplaintEvent } from "../lib/ticketEvents";
import { notifyMany, ticketRecipients } from "../lib/ticketNotify";

export const complaintCronRouter = Router();

complaintCronRouter.get("/escalate", async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = new Date();
  const sla = slaFromSettings(await prisma.companySettings.findUnique({ where: { id: "singleton" } }));
  const cutoff = new Date(now.getTime() - sla.regionalManagerHours * 3_600_000);

  const candidates = await prisma.complaint.findMany({
    where: { status: { notIn: SLA_PAUSED_STATUSES }, slaEscalationLevel: { lt: 2 }, createdAt: { lte: cutoff } },
    include: {
      site: { select: { regionId: true } },
      unit: { select: { serialNo: true } },
      customer: { select: { name: true } },
    },
  });

  let level1 = 0;
  let level2 = 0;
  for (const c of candidates) {
    const target = targetEscalationLevel(c, sla, now);
    if (target <= c.slaEscalationLevel) continue;

    // Claim the new level; if another run got there first, skip.
    const claimed = await prisma.complaint.updateMany({
      where: { id: c.id, slaEscalationLevel: c.slaEscalationLevel },
      data: { slaEscalationLevel: target, lastEscalatedAt: now },
    });
    if (claimed.count === 0) continue;

    const ageHours = Math.floor((now.getTime() - c.createdAt.getTime()) / 3_600_000);
    const base = {
      ticketNumber: c.ticketNumber,
      customerName: c.customer.name,
      serialNo: c.unit?.serialNo ?? null,
      status: c.status,
      ageHours,
    };
    // A level jump (cron was down) still alerts every audience it skipped.
    for (let lvl = c.slaEscalationLevel + 1; lvl <= target; lvl++) {
      const audience = lvl === 1 ? "regional" : "management";
      await logComplaintEvent({
        complaintId: c.id,
        type: COMPLAINT_EVENT.ESCALATED,
        fromValue: String(lvl - 1),
        toValue: String(lvl),
        actorLabel: "System (SLA)",
        detail: { audience, ageHours },
      });
      try {
        const recipients = await ticketRecipients(audience, { regionId: c.site?.regionId });
        await notifyMany(recipients, "complaint_escalated", { ...base, level: lvl, audience });
      } catch (err) {
        console.error("Escalation notification failed", err);
      }
      if (lvl === 1) level1++;
      else level2++;
    }
  }

  res.json({ ok: true, checked: candidates.length, escalatedToRegional: level1, escalatedToManagement: level2 });
});
