-- Region-wise Service Manager reminders (Requirement 6). FOR REVIEW - not applied to any shared or production database.
--
-- Additive only: new columns (Complaint.dueDate, CompanySettings reminder policy - both NULL = off) and new tables
-- (AmcVisit, ServiceReminder, ServiceReminderEvent, RegionManagerAudit). No existing row changes meaning; existing regions,
-- assignments, tickets, AMC records and notification logs are untouched. Nothing is reminded or escalated until a person
-- sets a due date AND the reminder policy is filled in (Settings). Deploy order: after 20261018090000_amc_service_reports,
-- before the code. The Prisma-generated DDL comes first; the CHECK constraints after it are protections Prisma cannot express.

-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN     "reminderEscalationHours" INTEGER,
ADD COLUMN     "reminderLeadDays" INTEGER;

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "dueDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RegionManagerAudit" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "actorId" TEXT,
    "userIdsBefore" JSONB NOT NULL,
    "userIdsAfter" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegionManagerAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmcVisit" (
    "id" TEXT NOT NULL,
    "amcOrderId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmcVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceReminder" (
    "id" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "complaintId" TEXT,
    "amcVisitId" TEXT,
    "regionId" TEXT,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "siteId" TEXT,
    "siteName" TEXT,
    "unitId" TEXT,
    "unitSerialNo" TEXT,
    "activityRef" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "lastEscalatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceReminderEvent" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "recipientId" TEXT,
    "channel" TEXT,
    "actorId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceReminderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegionManagerAudit_regionId_createdAt_idx" ON "RegionManagerAudit"("regionId", "createdAt");

-- CreateIndex
CREATE INDEX "AmcVisit_status_dueDate_idx" ON "AmcVisit"("status", "dueDate");

-- CreateIndex
CREATE INDEX "AmcVisit_amcOrderId_idx" ON "AmcVisit"("amcOrderId");

-- CreateIndex
CREATE INDEX "AmcVisit_unitId_idx" ON "AmcVisit"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceReminder_complaintId_key" ON "ServiceReminder"("complaintId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceReminder_amcVisitId_key" ON "ServiceReminder"("amcVisitId");

-- CreateIndex
CREATE INDEX "ServiceReminder_status_idx" ON "ServiceReminder"("status");

-- CreateIndex
CREATE INDEX "ServiceReminder_regionId_status_idx" ON "ServiceReminder"("regionId", "status");

-- CreateIndex
CREATE INDEX "ServiceReminder_dueDate_idx" ON "ServiceReminder"("dueDate");

-- CreateIndex
CREATE INDEX "ServiceReminderEvent_reminderId_createdAt_idx" ON "ServiceReminderEvent"("reminderId", "createdAt");

-- CreateIndex
CREATE INDEX "Complaint_dueDate_idx" ON "Complaint"("dueDate");

-- AddForeignKey
ALTER TABLE "RegionManagerAudit" ADD CONSTRAINT "RegionManagerAudit_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegionManagerAudit" ADD CONSTRAINT "RegionManagerAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcVisit" ADD CONSTRAINT "AmcVisit_amcOrderId_fkey" FOREIGN KEY ("amcOrderId") REFERENCES "AmcOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcVisit" ADD CONSTRAINT "AmcVisit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcVisit" ADD CONSTRAINT "AmcVisit_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_amcVisitId_fkey" FOREIGN KEY ("amcVisitId") REFERENCES "AmcVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminderEvent" ADD CONSTRAINT "ServiceReminderEvent_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "ServiceReminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReminderEvent" ADD CONSTRAINT "ServiceReminderEvent_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Exactly one activity per reminder, matching its type; closed reminders carry a closing time.
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_activity_check" CHECK (
  ("activityType" = 'ticket' AND "complaintId" IS NOT NULL AND "amcVisitId" IS NULL)
  OR ("activityType" = 'amc_visit' AND "amcVisitId" IS NOT NULL AND "complaintId" IS NULL)
);
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_status_check" CHECK (
  "status" IN ('pending', 'sending', 'sent', 'failed', 'no_recipient', 'acknowledged', 'closed')
);
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_escalation_level_check" CHECK ("escalationLevel" BETWEEN 0 AND 2);
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_closed_check" CHECK ("status" <> 'closed' OR "closedAt" IS NOT NULL);
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_ack_check" CHECK ("status" <> 'acknowledged' OR ("acknowledgedAt" IS NOT NULL));

-- Closed vocabulary for AMC visits.
ALTER TABLE "AmcVisit" ADD CONSTRAINT "AmcVisit_status_check" CHECK ("status" IN ('scheduled', 'completed', 'cancelled'));
ALTER TABLE "AmcVisit" ADD CONSTRAINT "AmcVisit_completed_check" CHECK ("status" <> 'completed' OR "completedAt" IS NOT NULL);

-- Reminder policy values, when set, must be sensible.
ALTER TABLE "CompanySettings" ADD CONSTRAINT "CompanySettings_reminder_policy_check" CHECK (
  ("reminderLeadDays" IS NULL OR "reminderLeadDays" BETWEEN 0 AND 365)
  AND ("reminderEscalationHours" IS NULL OR "reminderEscalationHours" >= 1)
);
