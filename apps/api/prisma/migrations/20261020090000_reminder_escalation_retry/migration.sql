-- Requirement 6 correction: failed escalation deliveries stay retryable.
-- Until now an escalation level was claimed (escalationLevel advanced) BEFORE anything was delivered, so a level whose
-- delivery failed was lost. From now on escalationLevel advances only when the level was delivered (or had no recipient);
-- these two columns carry the attempt count for the NEXT level and a lease so overlapping job runs cannot both deliver it.
-- Additive: no existing row changes meaning (every reminder starts with 0 attempts and no lease).

-- AlterTable
ALTER TABLE "ServiceReminder" ADD COLUMN     "escalationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "escalationClaimedAt" TIMESTAMP(3);

ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_escalation_attempts_check" CHECK ("escalationAttempts" >= 0);
