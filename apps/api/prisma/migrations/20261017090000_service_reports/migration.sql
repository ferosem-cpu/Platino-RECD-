-- Digital service reports (Requirement 4). FOR REVIEW - not applied to any shared or production database.
--
-- Additive only: two new tables. Complaint.serviceReportUrl (the legacy staff upload) and every existing row are
-- untouched, so existing attachments keep working. Deploy order: apply this migration BEFORE deploying the code
-- (the new routes and the RECD-unit history query read the ServiceReport table).
--
-- The Prisma-generated DDL comes first; the statements after it are protections Prisma cannot express:
--  * at most ONE unsigned (draft / awaiting signature) report per ticket - a signed report does not block a new visit;
--  * the status vocabulary is closed, and a row can only be "signed" if it carries the signer, time, signature file,
--    PDF file and PDF hash - an incomplete report can never be stored as signed;
--  * once signed, a report's content can never be changed (trigger). Only the nullable links that the database
--    itself clears (site / unit / user deleted -> SET NULL) may still change.

-- CreateTable
CREATE TABLE "ServiceReport" (
    "id" TEXT NOT NULL,
    "reportNumber" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "siteId" TEXT,
    "unitId" TEXT,
    "createdById" TEXT NOT NULL,
    "submittedById" TEXT,
    "visitDate" TIMESTAMP(3) NOT NULL,
    "workPerformed" TEXT NOT NULL DEFAULT '',
    "findings" TEXT NOT NULL DEFAULT '',
    "resolution" TEXT NOT NULL DEFAULT '',
    "partsUsed" TEXT,
    "remarks" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signedVersion" INTEGER,
    "signerName" TEXT,
    "signedById" TEXT,
    "signatureFileId" TEXT,
    "pdfFileId" TEXT,
    "pdfSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportFile" (
    "id" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceReport_reportNumber_key" ON "ServiceReport"("reportNumber");

-- CreateIndex
CREATE INDEX "ServiceReport_complaintId_idx" ON "ServiceReport"("complaintId");

-- CreateIndex
CREATE INDEX "ServiceReport_customerId_idx" ON "ServiceReport"("customerId");

-- CreateIndex
CREATE INDEX "ServiceReport_siteId_idx" ON "ServiceReport"("siteId");

-- CreateIndex
CREATE INDEX "ServiceReport_unitId_idx" ON "ServiceReport"("unitId");

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_signatureFileId_fkey" FOREIGN KEY ("signatureFileId") REFERENCES "ReportFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_pdfFileId_fkey" FOREIGN KEY ("pdfFileId") REFERENCES "ReportFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One unsigned report per ticket
CREATE UNIQUE INDEX "ServiceReport_one_unsigned_per_complaint" ON "ServiceReport"("complaintId") WHERE "status" <> 'signed';

-- Closed vocabulary + "signed means complete"
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_status_check" CHECK ("status" IN ('draft', 'awaiting_signature', 'signed'));
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_signed_complete_check" CHECK (
  "status" <> 'signed' OR (
    "signedAt" IS NOT NULL AND "signedVersion" IS NOT NULL AND "signerName" IS NOT NULL AND "signatureFileId" IS NOT NULL
    AND "pdfFileId" IS NOT NULL AND "pdfSha256" IS NOT NULL AND "contentHash" IS NOT NULL AND "submittedAt" IS NOT NULL
  )
);

-- A signed report is immutable
CREATE FUNCTION "service_report_signed_is_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'signed' AND (
    NEW."reportNumber" IS DISTINCT FROM OLD."reportNumber" OR NEW."complaintId" IS DISTINCT FROM OLD."complaintId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."visitDate" IS DISTINCT FROM OLD."visitDate" OR NEW."workPerformed" IS DISTINCT FROM OLD."workPerformed"
    OR NEW."findings" IS DISTINCT FROM OLD."findings" OR NEW."resolution" IS DISTINCT FROM OLD."resolution"
    OR NEW."partsUsed" IS DISTINCT FROM OLD."partsUsed" OR NEW."remarks" IS DISTINCT FROM OLD."remarks"
    OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
    OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt" OR NEW."signedVersion" IS DISTINCT FROM OLD."signedVersion"
    OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."signatureFileId" IS DISTINCT FROM OLD."signatureFileId"
    OR NEW."pdfFileId" IS DISTINCT FROM OLD."pdfFileId" OR NEW."pdfSha256" IS DISTINCT FROM OLD."pdfSha256"
  ) THEN
    RAISE EXCEPTION 'A signed service report is final and cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServiceReport_signed_is_final" BEFORE UPDATE ON "ServiceReport"
  FOR EACH ROW EXECUTE FUNCTION "service_report_signed_is_final"();
