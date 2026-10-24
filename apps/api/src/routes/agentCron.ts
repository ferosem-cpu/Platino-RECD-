/** Daily cleanup of AgentConversation rows older than 30 days (decision: conversation
 * history isn't a permanent audit trail, so it's fine to expire, and it keeps Supabase
 * storage/costs bounded). Invoked by Vercel Cron
 * (see the `crons` entry in vercel.json), which sends `Authorization: Bearer $CRON_SECRET`
 * automatically when CRON_SECRET is set as a project env var - this route rejects anything
 * else (including every request when CRON_SECRET is not set) so it can't be triggered by an arbitrary request.
 */
import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { prisma } from "../lib/prisma";

export const agentCronRouter = Router();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** True only for `Authorization: Bearer <CRON_SECRET>` (compared in constant time). An unset or empty secret never matches anything. */
function isAuthorisedCron(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

agentCronRouter.get("/cron/cleanup-conversations", async (req, res) => {
  // Fails closed: with no CRON_SECRET configured (or a wrong one) nothing is deleted - the same rule as the other cron routes.
  if (!isAuthorisedCron(req.headers.authorization)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const result = await prisma.agentConversation.deleteMany({
    where: { updatedAt: { lt: cutoff } },
  });
  res.json({ deleted: result.count });
});
