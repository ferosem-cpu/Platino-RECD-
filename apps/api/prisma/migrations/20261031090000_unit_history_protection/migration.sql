-- Requirement 1 (RECD serial): protect a unit's history and make serial corrections traceable.
--
-- 1. A RECD unit that tickets, service reports or service reminders point at can no longer be deleted. Those three foreign keys were
--    ON DELETE SET NULL, so deleting a unit (for example by removing an order line item) silently detached its history and freed the
--    serial. They become RESTRICT, like the AMC, AMC-visit and warranty-history links that already were. No data is read or changed:
--    existing rows keep satisfying the constraints.
-- 2. "RecdUnitSerialHistory": append-only record of every correction of an already-set serial (previous and new serial, reason, actor).
--
-- NOT APPLIED to any shared or production database - for the database owner to review and apply (`prisma migrate deploy`).
-- Order: apply BEFORE deploying the code (the new endpoint writes the table). Rolling back the code leaves this migration harmless.
-- Rollback: DROP TABLE "RecdUnitSerialHistory"; and re-create the three foreign keys with ON DELETE SET NULL.

ALTER TABLE "Complaint" DROP CONSTRAINT "Complaint_unitId_fkey";
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServiceReport" DROP CONSTRAINT "ServiceReport_unitId_fkey";
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ServiceReminder" DROP CONSTRAINT "ServiceReminder_unitId_fkey";
ALTER TABLE "ServiceReminder" ADD CONSTRAINT "ServiceReminder_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "RecdUnitSerialHistory" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "previousSerialNo" TEXT NOT NULL,
    "newSerialNo" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecdUnitSerialHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecdUnitSerialHistory_unitId_createdAt_idx" ON "RecdUnitSerialHistory"("unitId", "createdAt");

-- AddForeignKey
ALTER TABLE "RecdUnitSerialHistory" ADD CONSTRAINT "RecdUnitSerialHistory_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecdUnitSerialHistory" ADD CONSTRAINT "RecdUnitSerialHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row level security on, like every other table (the API connects with the owner role; this blocks direct anonymous access).
ALTER TABLE "RecdUnitSerialHistory" ENABLE ROW LEVEL SECURITY;
