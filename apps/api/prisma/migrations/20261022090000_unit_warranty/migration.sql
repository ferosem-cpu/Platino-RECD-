-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN     "warrantyReminderLeadDays" INTEGER,
ADD COLUMN     "warrantyReminderRepeatDays" INTEGER;

-- AlterTable
ALTER TABLE "RecdUnit" ADD COLUMN     "warrantyEndDate" DATE,
ADD COLUMN     "warrantyMonths" INTEGER,
ADD COLUMN     "warrantySource" TEXT,
ADD COLUMN     "warrantyStartDate" DATE;

-- CreateTable
CREATE TABLE "WarrantyHistory" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "previousStartDate" DATE,
    "previousEndDate" DATE,
    "previousMonths" INTEGER,
    "previousSource" TEXT,
    "newStartDate" DATE NOT NULL,
    "newEndDate" DATE NOT NULL,
    "newMonths" INTEGER,
    "newSource" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarrantyHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarrantyReminderDelivery" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "warrantyEndDate" DATE NOT NULL,
    "recipientId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarrantyReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarrantyHistory_unitId_createdAt_idx" ON "WarrantyHistory"("unitId", "createdAt");

-- CreateIndex
CREATE INDEX "WarrantyReminderDelivery_warrantyEndDate_idx" ON "WarrantyReminderDelivery"("warrantyEndDate");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyReminderDelivery_unitId_warrantyEndDate_recipientId_key" ON "WarrantyReminderDelivery"("unitId", "warrantyEndDate", "recipientId");

-- CreateIndex
CREATE INDEX "RecdUnit_warrantyEndDate_idx" ON "RecdUnit"("warrantyEndDate");

-- AddForeignKey
ALTER TABLE "WarrantyHistory" ADD CONSTRAINT "WarrantyHistory_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyHistory" ADD CONSTRAINT "WarrantyHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyReminderDelivery" ADD CONSTRAINT "WarrantyReminderDelivery_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyReminderDelivery" ADD CONSTRAINT "WarrantyReminderDelivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Requirement 8: unit warranty. ADDITIVE ONLY: no existing row is changed. There is NO backfill - every existing unit keeps all four
-- warranty columns NULL ("not recorded") because no reliable warranty start date exists for legacy units (order, PO, dispatch, delivery
-- and commissioning dates are different things and are deliberately not used).
-- ---------------------------------------------------------------------------------------------------------------------

-- A unit's warranty is either entirely unrecorded or complete and consistent.
ALTER TABLE "RecdUnit" ADD CONSTRAINT "RecdUnit_warranty_check" CHECK (
  ("warrantyStartDate" IS NULL AND "warrantyEndDate" IS NULL AND "warrantyMonths" IS NULL AND "warrantySource" IS NULL)
  OR ("warrantyStartDate" IS NOT NULL AND "warrantyEndDate" IS NOT NULL
      AND "warrantySource" IS NOT NULL
      AND "warrantySource" IN ('manual', 'calculated', 'product_default')
      AND "warrantyEndDate" >= "warrantyStartDate"
      AND ("warrantyMonths" IS NULL OR "warrantyMonths" BETWEEN 1 AND 120)
      AND ("warrantySource" = 'manual' OR "warrantyMonths" IS NOT NULL))
);

-- The history is a clean, append-only record of valid changes.
ALTER TABLE "WarrantyHistory" ADD CONSTRAINT "WarrantyHistory_kind_check" CHECK ("kind" IN ('established', 'correction'));
ALTER TABLE "WarrantyHistory" ADD CONSTRAINT "WarrantyHistory_periods_check" CHECK (
  "newEndDate" >= "newStartDate"
  AND (("previousStartDate" IS NULL) = ("previousEndDate" IS NULL))
  AND ("previousEndDate" IS NULL OR "previousEndDate" >= "previousStartDate")
);
ALTER TABLE "WarrantyHistory" ADD CONSTRAINT "WarrantyHistory_previous_check" CHECK (
  ("kind" = 'established' AND "previousStartDate" IS NULL)
  OR ("kind" = 'correction' AND "previousStartDate" IS NOT NULL AND "reason" IS NOT NULL AND length(btrim("reason")) >= 3)
);
ALTER TABLE "WarrantyHistory" ADD CONSTRAINT "WarrantyHistory_source_check" CHECK (
  "newSource" IN ('manual', 'calculated', 'product_default')
  AND ("previousSource" IS NULL OR "previousSource" IN ('manual', 'calculated', 'product_default'))
);
ALTER TABLE "WarrantyReminderDelivery" ADD CONSTRAINT "WarrantyReminderDelivery_attempts_check" CHECK ("attempts" >= 0);

-- Settings are bounded; NULL = the default.
ALTER TABLE "CompanySettings" ADD CONSTRAINT "CompanySettings_warranty_settings_check" CHECK (
  ("warrantyReminderLeadDays" IS NULL OR "warrantyReminderLeadDays" BETWEEN 0 AND 365)
  AND ("warrantyReminderRepeatDays" IS NULL OR "warrantyReminderRepeatDays" BETWEEN 1 AND 90)
);

-- Same row-level-security posture as the other new tables (the API connects as the table owner).
ALTER TABLE "WarrantyHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarrantyReminderDelivery" ENABLE ROW LEVEL SECURITY;

-- Permission: manage_warranty (record / correct unit warranty dates). Granted to the same roles that hold every permission except
-- settings (super_admin, owner_admin, management) - the precedent set for manage_regions. NOT granted to sales, service or any
-- vendor / customer role. Isolated here so the mapping can be reviewed and changed in one place.
INSERT INTO "Permission" ("id", "key", "name")
SELECT gen_random_uuid()::text, 'manage_warranty', 'Record and correct RECD unit warranty'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "key" = 'manage_warranty');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r, "Permission" p
WHERE r."key" IN ('super_admin', 'owner_admin', 'management') AND p."key" = 'manage_warranty'
ON CONFLICT DO NOTHING;
