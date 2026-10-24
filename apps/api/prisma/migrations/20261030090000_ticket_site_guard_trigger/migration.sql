-- Requirement 11 (prevent duplicate tickets), approved decision A: closes the one race the partial unique indexes cannot see.
--
-- Complaint_one_open_per_unit covers two active tickets for one unit; Complaint_one_open_per_site_without_unit covers two active tickets
-- WITHOUT a unit on one site. Neither can see "a ticket without a unit" next to "a ticket for a unit that has since been RETIRED" (a site whose only
-- unit was retired is a site without a unit, and its old active ticket still counts as the site's active ticket - the portal has always refused a
-- second one). An index compares one column of one row; this needs two rows and the unit's status, so it is a trigger.
--
-- Rule (the approved definition, unchanged): a ticket that is ACTIVE (not resolved / closed, not archived) and has a site is "site-level" when it
-- has no unit or its unit is retired. A site-level ticket may not coexist with any other active ticket on the same site. A ticket for an
-- ACTIVE unit is not restricted here (the unit index governs it; a retire is one-way, so whichever of two racing inserts runs second sees a retired unit
-- or no unit and is the one that is refused). All active tickets of a site take the same per-site advisory lock for the
-- length of their transaction, so two simultaneous inserts serialise and the second one sees the first. The error is a unique violation, so
-- the application maps it to the same clear message as the indexes.
--
-- Fires only when a row is inserted, becomes active again, or changes site / unit - ordinary updates of existing rows (SLA fields, remarks, ...)
-- never raise, so rows that were already duplicated before this migration are not suddenly un-editable.
-- NOT APPLIED to any shared or production database. Additive: one function and one trigger; drop both to roll back.

CREATE OR REPLACE FUNCTION "complaint_site_level_guard"() RETURNS trigger AS $$
DECLARE
  site_level boolean;
BEGIN
  IF NEW."siteId" IS NULL OR NEW."archivedAt" IS NOT NULL OR NEW."status" IN ('resolved', 'closed') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."archivedAt" IS NULL AND OLD."status" NOT IN ('resolved', 'closed')
     AND OLD."siteId" IS NOT DISTINCT FROM NEW."siteId" AND OLD."unitId" IS NOT DISTINCT FROM NEW."unitId" THEN
    RETURN NEW; -- already active on the same site / unit: nothing about the duplicate rule changes
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('complaint-site:' || NEW."siteId", 0));

  site_level := NEW."unitId" IS NULL
    OR EXISTS (SELECT 1 FROM "RecdUnit" u WHERE u."id" = NEW."unitId" AND u."status" = 'retired');
  IF site_level THEN
    IF EXISTS (
      SELECT 1 FROM "Complaint" c
      WHERE c."siteId" = NEW."siteId" AND c."id" <> NEW."id" AND c."archivedAt" IS NULL AND c."status" NOT IN ('resolved', 'closed')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'unique_violation',
        MESSAGE = 'duplicate active ticket for a site without an active RECD unit',
        DETAIL = format('Key ("siteId")=(%s) already has an active ticket.', NEW."siteId"),
        CONSTRAINT = 'Complaint_one_active_per_siteId_guard';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Complaint_site_level_guard"
  BEFORE INSERT OR UPDATE OF "status", "archivedAt", "siteId", "unitId" ON "Complaint"
  FOR EACH ROW EXECUTE FUNCTION "complaint_site_level_guard"();
