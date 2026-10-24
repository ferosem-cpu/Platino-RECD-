-- Requirement 7: explicit AMC contract dates, vendor AMC contracts, renewal history, configurable AMC timing.
-- ADDITIVE ONLY: no column or table is dropped or renamed and no AMC row is deleted. Existing contracts keep their effective dates:
-- the backfill below reproduces the old rule (expiry = PO date + 1 year, same calendar date) as explicit dates and marks those rows
-- datesSource = 'legacy_po_date' so they can be told apart from dates typed in. "AmcOrder"."poDate" is NOT NULL, so every existing
-- row can be backfilled reliably; none is left without dates. Postgres computes Feb 29 + 1 year as Feb 28, which is also what the
-- application's legacy rule (addMonths(poDate, 12)) does, so the SQL and the code agree.
-- Apply AFTER 20261020090000_reminder_escalation_retry, before deploying the code that reads these columns.

-- AlterTable
ALTER TABLE "AmcOrder" ADD COLUMN     "datesSource" TEXT NOT NULL DEFAULT 'explicit',
ADD COLUMN     "endDate" DATE,
ADD COLUMN     "startDate" DATE;

-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN     "amcDefaultDurationMonths" INTEGER,
ADD COLUMN     "amcReminderLeadDays" INTEGER,
ADD COLUMN     "amcReminderRepeatDays" INTEGER;

-- CreateTable
CREATE TABLE "VendorAmc" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "contractRef" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastExpiryReminderAt" TIMESTAMP(3),
    "expiryReminderClearedAt" TIMESTAMP(3),
    "expiryReminderClearedById" TEXT,

    CONSTRAINT "VendorAmc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmcRenewal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'renewal',
    "amcOrderId" TEXT,
    "vendorAmcId" TEXT,
    "previousStartDate" DATE NOT NULL,
    "previousEndDate" DATE NOT NULL,
    "newStartDate" DATE NOT NULL,
    "newEndDate" DATE NOT NULL,
    "renewedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmcRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorAmc_vendorId_idx" ON "VendorAmc"("vendorId");

-- CreateIndex
CREATE INDEX "VendorAmc_endDate_idx" ON "VendorAmc"("endDate");

-- CreateIndex
CREATE INDEX "AmcRenewal_amcOrderId_createdAt_idx" ON "AmcRenewal"("amcOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "AmcRenewal_vendorAmcId_createdAt_idx" ON "AmcRenewal"("vendorAmcId", "createdAt");

-- AddForeignKey
ALTER TABLE "VendorAmc" ADD CONSTRAINT "VendorAmc_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAmc" ADD CONSTRAINT "VendorAmc_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAmc" ADD CONSTRAINT "VendorAmc_expiryReminderClearedById_fkey" FOREIGN KEY ("expiryReminderClearedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_amcOrderId_fkey" FOREIGN KEY ("amcOrderId") REFERENCES "AmcOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_vendorAmcId_fkey" FOREIGN KEY ("vendorAmcId") REFERENCES "VendorAmc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_renewedById_fkey" FOREIGN KEY ("renewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: legacy contracts get explicit dates equal to what the old code derived. "poDate" is a timestamp WITHOUT time zone that the
-- application writes in UTC, so ::date is the UTC calendar date (no session time-zone conversion is involved).
UPDATE "AmcOrder"
SET "startDate" = "poDate"::date,
    "endDate" = ("poDate"::date + interval '1 year')::date,
    "datesSource" = 'legacy_po_date'
WHERE "startDate" IS NULL AND "endDate" IS NULL;

-- Integrity rules.
ALTER TABLE "AmcOrder" ADD CONSTRAINT "AmcOrder_period_check" CHECK (
  ("startDate" IS NULL AND "endDate" IS NULL) OR ("startDate" IS NOT NULL AND "endDate" IS NOT NULL AND "endDate" > "startDate")
);
ALTER TABLE "AmcOrder" ADD CONSTRAINT "AmcOrder_dates_source_check" CHECK ("datesSource" IN ('explicit', 'legacy_po_date'));
ALTER TABLE "VendorAmc" ADD CONSTRAINT "VendorAmc_period_check" CHECK ("endDate" > "startDate");
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_kind_check" CHECK ("kind" IN ('renewal', 'correction'));
-- exactly one parent: a customer AMC or a vendor AMC, never both and never neither
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_parent_check" CHECK (("amcOrderId" IS NOT NULL) <> ("vendorAmcId" IS NOT NULL));
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_periods_check" CHECK ("previousEndDate" > "previousStartDate" AND "newEndDate" > "newStartDate");
-- a renewal must start after the period it renews
ALTER TABLE "AmcRenewal" ADD CONSTRAINT "AmcRenewal_renewal_order_check" CHECK ("kind" <> 'renewal' OR "newStartDate" > "previousEndDate");
-- at most ONE renewal per contract and previous end date: a double submit or a race cannot record the same renewal twice
CREATE UNIQUE INDEX "AmcRenewal_one_renewal_per_period_order" ON "AmcRenewal" ("amcOrderId", "previousEndDate") WHERE "kind" = 'renewal' AND "amcOrderId" IS NOT NULL;
CREATE UNIQUE INDEX "AmcRenewal_one_renewal_per_period_vendor" ON "AmcRenewal" ("vendorAmcId", "previousEndDate") WHERE "kind" = 'renewal' AND "vendorAmcId" IS NOT NULL;

-- Settings, when set, must be sensible (NULL = the compatible default).
ALTER TABLE "CompanySettings" ADD CONSTRAINT "CompanySettings_amc_settings_check" CHECK (
  ("amcDefaultDurationMonths" IS NULL OR "amcDefaultDurationMonths" BETWEEN 1 AND 120)
  AND ("amcReminderLeadDays" IS NULL OR "amcReminderLeadDays" BETWEEN 0 AND 365)
  AND ("amcReminderRepeatDays" IS NULL OR "amcReminderRepeatDays" BETWEEN 1 AND 90)
);

-- Same posture as every other table: row-level security on, no policies (the API connects as the table owner).
ALTER TABLE "VendorAmc" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AmcRenewal" ENABLE ROW LEVEL SECURITY;
