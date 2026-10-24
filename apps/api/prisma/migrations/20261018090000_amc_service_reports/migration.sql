-- AMC service reports (Requirement 5). FOR REVIEW - not applied to any shared or production database.
--
-- Extends the Requirement 4 table (migration 20261017090000_service_reports - apply that one FIRST) so a service
-- report can belong to an AMC order as well as to a service ticket. Additive and backward compatible:
--  * existing rows keep working: kind defaults to 'ticket', acknowledgementRequired to true, complaintId stays set;
--  * ReportFile rows and the signed-row protections are kept (the trigger is replaced by a superset);
--  * the only relaxation is complaintId becoming nullable - the CHECK below keeps "exactly one owner" true.
-- Deploy order: R4 migration, then this one, then the code.

-- AlterTable
ALTER TABLE "ServiceReport" ADD COLUMN     "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "amcOrderId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'ticket',
ADD COLUMN     "unitSerialNo" TEXT,
ALTER COLUMN "complaintId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ServiceReportEvent" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceReportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceReportEvent_reportId_createdAt_idx" ON "ServiceReportEvent"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceReport_amcOrderId_idx" ON "ServiceReport"("amcOrderId");

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_amcOrderId_fkey" FOREIGN KEY ("amcOrderId") REFERENCES "AmcOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReportEvent" ADD CONSTRAINT "ServiceReportEvent_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ServiceReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReportEvent" ADD CONSTRAINT "ServiceReportEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Snapshot the serial of the unit for reports that already exist (done BEFORE the trigger is replaced).
UPDATE "ServiceReport" r SET "unitSerialNo" = u."serialNo" FROM "RecdUnit" u WHERE r."unitId" = u."id" AND r."unitSerialNo" IS NULL;

-- Exactly one owner, matching kind; an AMC report always carries its serial snapshot; ticket reports always need a signature.
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_kind_owner_check" CHECK (
  ("kind" = 'ticket' AND "complaintId" IS NOT NULL AND "amcOrderId" IS NULL AND "acknowledgementRequired" = true)
  OR ("kind" = 'amc' AND "amcOrderId" IS NOT NULL AND "complaintId" IS NULL AND "unitSerialNo" IS NOT NULL)
);

-- New final state "submitted" (AMC reports that do not need a customer signature).
ALTER TABLE "ServiceReport" DROP CONSTRAINT "ServiceReport_status_check";
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_status_check" CHECK ("status" IN ('draft', 'awaiting_signature', 'signed', 'submitted'));
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_final_states_check" CHECK (
  ("status" <> 'signed' OR "acknowledgementRequired" = true)
  AND ("status" <> 'submitted' OR (
    "acknowledgementRequired" = false AND "pdfFileId" IS NOT NULL AND "pdfSha256" IS NOT NULL AND "contentHash" IS NOT NULL
    AND "submittedAt" IS NOT NULL AND "signedAt" IS NULL AND "signatureFileId" IS NULL
  ))
);

-- One report IN PROGRESS per ticket (as before, but a 'submitted' report is final too) and per AMC order + unit.
-- Finished reports never block the next visit.
DROP INDEX "ServiceReport_one_unsigned_per_complaint";
CREATE UNIQUE INDEX "ServiceReport_one_open_per_complaint" ON "ServiceReport"("complaintId")
  WHERE "status" IN ('draft', 'awaiting_signature') AND "complaintId" IS NOT NULL;
CREATE UNIQUE INDEX "ServiceReport_one_open_per_amc_unit" ON "ServiceReport"("amcOrderId", "unitId")
  WHERE "status" IN ('draft', 'awaiting_signature') AND "amcOrderId" IS NOT NULL;

-- Final reports (signed or submitted) are immutable. Superset of the previous trigger function.
CREATE OR REPLACE FUNCTION "service_report_signed_is_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('signed', 'submitted') AND (
    NEW."reportNumber" IS DISTINCT FROM OLD."reportNumber" OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."complaintId" IS DISTINCT FROM OLD."complaintId" OR NEW."amcOrderId" IS DISTINCT FROM OLD."amcOrderId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."unitSerialNo" IS DISTINCT FROM OLD."unitSerialNo" OR NEW."acknowledgementRequired" IS DISTINCT FROM OLD."acknowledgementRequired"
    OR NEW."visitDate" IS DISTINCT FROM OLD."visitDate" OR NEW."workPerformed" IS DISTINCT FROM OLD."workPerformed"
    OR NEW."findings" IS DISTINCT FROM OLD."findings" OR NEW."resolution" IS DISTINCT FROM OLD."resolution"
    OR NEW."partsUsed" IS DISTINCT FROM OLD."partsUsed" OR NEW."remarks" IS DISTINCT FROM OLD."remarks"
    OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
    OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt" OR NEW."signedVersion" IS DISTINCT FROM OLD."signedVersion"
    OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."signatureFileId" IS DISTINCT FROM OLD."signatureFileId"
    OR NEW."pdfFileId" IS DISTINCT FROM OLD."pdfFileId" OR NEW."pdfSha256" IS DISTINCT FROM OLD."pdfSha256"
  ) THEN
    RAISE EXCEPTION 'A signed or submitted service report is final and cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
