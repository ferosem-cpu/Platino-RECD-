-- Phase 3: ticket history + SLA escalation.

ALTER TABLE "Complaint"
  ADD COLUMN "slaEscalationLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastEscalatedAt" TIMESTAMP(3);

ALTER TABLE "CompanySettings"
  ADD COLUMN "slaRegionalManagerHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "slaManagementHours" INTEGER NOT NULL DEFAULT 48;

CREATE TABLE "ComplaintEvent" (
  "id" TEXT NOT NULL,
  "complaintId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "fromValue" TEXT,
  "toValue" TEXT,
  "actorId" TEXT,
  "actorLabel" TEXT,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ComplaintEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ComplaintEvent_complaintId_createdAt_idx" ON "ComplaintEvent"("complaintId", "createdAt");

ALTER TABLE "ComplaintEvent" ADD CONSTRAINT "ComplaintEvent_complaintId_fkey"
  FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplaintEvent" ADD CONSTRAINT "ComplaintEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ComplaintEvent" ENABLE ROW LEVEL SECURITY;

-- Backfill: one "created" event per existing ticket (idempotent).
INSERT INTO "ComplaintEvent" ("id", "complaintId", "type", "toValue", "actorLabel", "createdAt")
SELECT 'bf_' || c."id", c."id", 'created', c."status", 'Migrated', c."createdAt"
FROM "Complaint" c
WHERE NOT EXISTS (SELECT 1 FROM "ComplaintEvent" e WHERE e."complaintId" = c."id");

-- Tickets that already exist when this ships are marked as fully escalated so the first cron
-- run does not flood Regional Managers / Management with alerts for the whole backlog.
UPDATE "Complaint" SET "slaEscalationLevel" = 2 WHERE "status" NOT IN ('resolved', 'closed');
