-- Requirement 11 (ticket history and closure): a ticket is no longer hard-deleted. DELETE /complaints/:id now ARCHIVES it, so the ticket, its
-- history (ComplaintEvent), its reminder and its escalation records are kept. Closure also records WHO closed the ticket.
--
-- NOT APPLIED to any shared or production database - for the database owner to review and apply (`prisma migrate deploy`).
-- Additive: four nullable columns, two foreign keys (ON DELETE SET NULL), one CHECK, one index, and the open-ticket-per-unit partial unique
-- index is recreated so that an ARCHIVED ticket no longer occupies its unit. Existing tickets are all live (archivedAt NULL), so the recreated
-- index matches exactly the same rows as before - it cannot fail on existing data. closedById is backfilled from the existing history.
-- Apply BEFORE deploying the API that reads these columns.

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN "closedById" TEXT,
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedById" TEXT,
ADD COLUMN "archiveReason" TEXT;

-- Archive details only make sense on an archived ticket (archivedById may later become NULL if that user is deleted).
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_archive_check"
  CHECK ("archivedAt" IS NOT NULL OR ("archivedById" IS NULL AND "archiveReason" IS NULL));

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Complaint_archivedAt_idx" ON "Complaint"("archivedAt");

-- One open ticket per unit: finished (resolved / closed) AND archived tickets no longer count. (Partial index - Prisma cannot express it.)
DROP INDEX "Complaint_one_open_per_unit";
CREATE UNIQUE INDEX "Complaint_one_open_per_unit"
  ON "Complaint" ("unitId")
  WHERE "unitId" IS NOT NULL AND "status" NOT IN ('resolved', 'closed') AND "archivedAt" IS NULL;

-- Backfill: who closed the tickets that are closed now = the actor of the latest "moved to closed" history event (nothing is invented:
-- a ticket without such an event, or whose event has no actor, keeps closedById NULL).
UPDATE "Complaint" AS c
SET "closedById" = e."actorId"
FROM (
  SELECT DISTINCT ON ("complaintId") "complaintId", "actorId"
  FROM "ComplaintEvent"
  WHERE "type" = 'status_changed' AND "toValue" = 'closed' AND "actorId" IS NOT NULL
  ORDER BY "complaintId", "createdAt" DESC
) AS e
WHERE e."complaintId" = c."id" AND c."status" = 'closed' AND c."closedAt" IS NOT NULL;
