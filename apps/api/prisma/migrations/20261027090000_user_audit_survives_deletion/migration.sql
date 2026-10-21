-- Security remediation: deleting an account (for example a customer's contact, when the customer is deleted) must NOT erase the audit
-- trail of what was done to it. Until now UserAuditLog.targetUserId was NOT NULL with ON DELETE CASCADE, so removing the user silently
-- deleted every audit row about it.
--
-- NOT APPLIED to any shared or production database - for the database owner to review and apply (`prisma migrate deploy`).
-- Safe on existing data: additive columns, a relaxed constraint and a backfill; no row is deleted or rewritten except for filling the two
-- new columns. Order: apply BEFORE deploying the code that writes "targetIdRecorded".

-- AlterTable: the affected account's id as a plain value (no foreign key) and its display name, kept after the account is gone.
ALTER TABLE "UserAuditLog" ADD COLUMN "targetIdRecorded" TEXT,
ADD COLUMN "targetName" TEXT;

-- Backfill for every existing row (the account still exists for all of them, because the old cascade removed the rows with it).
UPDATE "UserAuditLog" AS l
SET "targetIdRecorded" = l."targetUserId",
    "targetName" = u."name"
FROM "User" AS u
WHERE u."id" = l."targetUserId";

-- The live link becomes optional, and deleting the account clears the link instead of deleting the audit row.
ALTER TABLE "UserAuditLog" ALTER COLUMN "targetUserId" DROP NOT NULL;
ALTER TABLE "UserAuditLog" DROP CONSTRAINT "UserAuditLog_targetUserId_fkey";
ALTER TABLE "UserAuditLog" ADD CONSTRAINT "UserAuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: history of one account (by the recorded id) still works after the account is deleted.
CREATE INDEX "UserAuditLog_targetIdRecorded_createdAt_idx" ON "UserAuditLog"("targetIdRecorded", "createdAt");
