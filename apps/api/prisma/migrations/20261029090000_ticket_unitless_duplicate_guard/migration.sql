-- Requirement 11 (prevent duplicate tickets): a ticket with NO unit (a site with no eligible RECD unit) is limited to ONE active ticket per
-- site by the portal's application-side check only - two simultaneous requests could both pass it. This index makes the SAME rule hold under
-- concurrency. The business definition is unchanged: active = not resolved / closed and not archived (exactly like Complaint_one_open_per_unit).
--
-- NOT APPLIED to any shared or production database - for the database owner to review and apply (`prisma migrate deploy`).
-- SAFE FAILURE: if the existing data already contains two ACTIVE unit-less tickets on one site, this migration stops with a message listing the
-- sites BEFORE creating the index (nothing is changed). Resolve / archive the extra tickets on the listed sites (or tell us the intended rule),
-- then run the deploy again.
-- Apply BEFORE deploying the API that maps this index's violation to a friendly answer.

DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('site %s: %s', "siteId", tickets), E'\n') INTO dup
  FROM (
    SELECT "siteId", string_agg("ticketNumber", ', ' ORDER BY "createdAt") AS tickets
    FROM "Complaint"
    WHERE "unitId" IS NULL AND "siteId" IS NOT NULL AND "status" NOT IN ('resolved', 'closed') AND "archivedAt" IS NULL
    GROUP BY "siteId" HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot add the one-active-unit-less-ticket-per-site guard: these sites already have several active tickets without a RECD unit:\n%', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "Complaint_one_open_per_site_without_unit"
  ON "Complaint" ("siteId")
  WHERE "unitId" IS NULL AND "siteId" IS NOT NULL AND "status" NOT IN ('resolved', 'closed') AND "archivedAt" IS NULL;
