-- Requirement 4 (digital service reports): make a FINAL (signed, or submitted-without-signature) service report and everything it rests on
-- immutable in the database itself, not only in the API.
--
-- What was already protected (migrations 20261017090000 / 20261018090000): the report text, numbers, status/version, content hash, the
-- signature facts and the file references. What was NOT, and is now:
--   1. the SITE and the RECD UNIT the report is about, the SUBMITTER and the SIGNER, the creation time and the primary key;
--      (submittedById / signedById may only become NULL, which is what the existing ON DELETE SET NULL does when that person's account is
--      deleted - they can never be re-pointed at someone else; the signer's typed name and the audit events keep who signed.)
--   2. DELETING a final report (its history events would have cascaded away with it);
--   3. the stored signature / PDF FILES (ReportFile rows): a file that a report points at can no longer be updated (it could already not be
--      deleted - ON DELETE RESTRICT);
--   4. the report's audit EVENTS (ServiceReportEvent): once the report is final its events can no longer be updated or deleted (except
--      losing the actor link when that person's account is deleted); new events can still be appended (the 'signed' event is written
--      just after the report becomes signed);
--   5. ServiceReport.siteId was ON DELETE SET NULL: deleting a site would have detached it from its reports. It is RESTRICT now, like the
--      unit link (migration 20261031090000) - a site that reports point at cannot be deleted.
-- Reports that are still draft / awaiting_signature are NOT affected: they can be edited, reopened and (if ever needed) deleted as before.
-- Historical AMC serial snapshots (unitSerialNo) were already protected and are never rewritten by a serial correction.
--
-- No row is read or changed; existing data satisfies every new rule (the new guards only look at future UPDATE / DELETE statements, and the
-- foreign key swap keeps all existing links). NOT APPLIED to any shared or production database - for the database owner to review and apply
-- with `prisma migrate deploy`. Apply BEFORE deploying the code; the code works with or without it.
-- Rollback: DROP TRIGGER "ServiceReport_final_no_delete" ON "ServiceReport"; DROP TRIGGER "ReportFile_referenced_is_final" ON "ReportFile";
--           DROP TRIGGER "ServiceReportEvent_final_is_append_only" ON "ServiceReportEvent"; DROP the three functions below; restore the
--           previous "service_report_signed_is_final" body from migration 20261018090000; recreate the siteId foreign key with ON DELETE SET NULL.

-- 1. Wider "final is immutable" guard (replaces the function body; the trigger "ServiceReport_signed_is_final" keeps pointing at it)
CREATE OR REPLACE FUNCTION "service_report_signed_is_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('signed', 'submitted') AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."reportNumber" IS DISTINCT FROM OLD."reportNumber" OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."complaintId" IS DISTINCT FROM OLD."complaintId" OR NEW."amcOrderId" IS DISTINCT FROM OLD."amcOrderId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."siteId" IS DISTINCT FROM OLD."siteId" OR NEW."unitId" IS DISTINCT FROM OLD."unitId"
    OR NEW."unitSerialNo" IS DISTINCT FROM OLD."unitSerialNo" OR NEW."acknowledgementRequired" IS DISTINCT FROM OLD."acknowledgementRequired"
    OR NEW."visitDate" IS DISTINCT FROM OLD."visitDate" OR NEW."workPerformed" IS DISTINCT FROM OLD."workPerformed"
    OR NEW."findings" IS DISTINCT FROM OLD."findings" OR NEW."resolution" IS DISTINCT FROM OLD."resolution"
    OR NEW."partsUsed" IS DISTINCT FROM OLD."partsUsed" OR NEW."remarks" IS DISTINCT FROM OLD."remarks"
    OR NEW."status" IS DISTINCT FROM OLD."status" OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
    OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt" OR NEW."signedVersion" IS DISTINCT FROM OLD."signedVersion"
    OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."signatureFileId" IS DISTINCT FROM OLD."signatureFileId"
    OR NEW."pdfFileId" IS DISTINCT FROM OLD."pdfFileId" OR NEW."pdfSha256" IS DISTINCT FROM OLD."pdfSha256"
    -- submitter / signer: the only allowed change is losing the link when that user account is deleted (ON DELETE SET NULL)
    OR (NEW."submittedById" IS DISTINCT FROM OLD."submittedById" AND NEW."submittedById" IS NOT NULL)
    OR (NEW."signedById" IS DISTINCT FROM OLD."signedById" AND NEW."signedById" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'A signed or submitted service report is final and cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. A final report cannot be deleted
CREATE FUNCTION "service_report_final_no_delete"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('signed', 'submitted') THEN
    RAISE EXCEPTION 'A signed or submitted service report is final and cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServiceReport_final_no_delete" BEFORE DELETE ON "ServiceReport"
  FOR EACH ROW EXECUTE FUNCTION "service_report_final_no_delete"();

-- 3. A stored file that a report points at is write-once (deleting it is already refused by the RESTRICT foreign keys)
CREATE FUNCTION "report_file_referenced_is_final"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceReport" r WHERE r."signatureFileId" = OLD."id" OR r."pdfFileId" = OLD."id") THEN
    RAISE EXCEPTION 'A stored service report file is final and cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReportFile_referenced_is_final" BEFORE UPDATE ON "ReportFile"
  FOR EACH ROW EXECUTE FUNCTION "report_file_referenced_is_final"();

-- 4. The audit events of a final report are append-only (INSERT stays allowed). The only change an UPDATE may make is losing the actor link
--    (ServiceReportEvent.actorId is ON DELETE SET NULL, so deleting the person's account must keep working); nothing else may change.
CREATE FUNCTION "service_report_event_final_is_append_only"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceReport" r WHERE r."id" = OLD."reportId" AND r."status" IN ('signed', 'submitted')) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'The history of a signed or submitted service report cannot be changed or deleted' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."reportId" IS DISTINCT FROM OLD."reportId" OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."fromValue" IS DISTINCT FROM OLD."fromValue" OR NEW."toValue" IS DISTINCT FROM OLD."toValue"
       OR NEW."detail" IS DISTINCT FROM OLD."detail" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR (NEW."actorId" IS DISTINCT FROM OLD."actorId" AND NEW."actorId" IS NOT NULL) THEN
      RAISE EXCEPTION 'The history of a signed or submitted service report cannot be changed or deleted' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ServiceReportEvent_final_is_append_only" BEFORE UPDATE OR DELETE ON "ServiceReportEvent"
  FOR EACH ROW EXECUTE FUNCTION "service_report_event_final_is_append_only"();

-- 5. A site that service reports point at cannot be deleted (was ON DELETE SET NULL)
ALTER TABLE "ServiceReport" DROP CONSTRAINT "ServiceReport_siteId_fkey";
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
