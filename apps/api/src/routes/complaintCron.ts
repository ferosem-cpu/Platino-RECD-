/**
 * SLA escalation sweep. Invoked by Vercel Cron (see vercel.json), which sends
 * `Authorization: Bearer $CRON_SECRET`. Mounted BEFORE the authenticated complaints router.
 *
 * An unresolved ticket older than the Regional Manager window alerts that region's managers
 * (level 1); older than the Management window it alerts Management (level 2). The logic lives in
 * lib/ticketEscalation.ts: a level only advances once every recipient has really been delivered the
 * message, a failed or empty delivery is retried by the next run, and overlapping runs never send twice.
 *
 * Interaction with the R6 due-date reminders (routes/reminders.ts, lib/reminders.ts): the two systems are independent - this one is driven
 * by ticket AGE, that one by an explicit DUE DATE - so a ticket with a due date can receive both. That is deliberate for now and is a
 * business decision to confirm (docs/HANDOVER.md).
 */
import { Router } from "express";
import { runTicketEscalation } from "../lib/ticketEscalation";

export const complaintCronRouter = Router();

complaintCronRouter.get("/escalate", async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const summary = await runTicketEscalation(new Date());
  res.json({ ok: true, ...summary });
});
