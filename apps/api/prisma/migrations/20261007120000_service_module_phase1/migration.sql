-- Service module phase 1: Regions + Regional Managers, per-unit RECD serials (RecdUnit),
-- PO number on orders, user audit log, new roles/permissions.
-- Fully idempotent where it touches existing data (roles/permissions/backfill), because
-- production never re-runs the seed.

-- Order: PO number
ALTER TABLE "Order" ADD COLUMN "poNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "poDate" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "poDuplicateFlag" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Order_customerId_poNumber_idx" ON "Order"("customerId", "poNumber");

-- Region + managers
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Region_key_key" ON "Region"("key");
CREATE UNIQUE INDEX "Region_name_key" ON "Region"("name");

CREATE TABLE "RegionManager" (
    "regionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "RegionManager_pkey" PRIMARY KEY ("regionId","userId")
);
CREATE INDEX "RegionManager_userId_idx" ON "RegionManager"("userId");
ALTER TABLE "RegionManager" ADD CONSTRAINT "RegionManager_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegionManager" ADD CONSTRAINT "RegionManager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Site region
ALTER TABLE "Site" ADD COLUMN "regionId" TEXT;
ALTER TABLE "Site" ADD CONSTRAINT "Site_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RECD units
CREATE TABLE "RecdUnit" (
    "id" TEXT NOT NULL,
    "serialNo" TEXT,
    "orderId" TEXT NOT NULL,
    "siteId" TEXT,
    "productId" TEXT NOT NULL,
    "lineItemId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecdUnit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecdUnit_serialNo_key" ON "RecdUnit"("serialNo");
CREATE INDEX "RecdUnit_orderId_idx" ON "RecdUnit"("orderId");
CREATE INDEX "RecdUnit_siteId_idx" ON "RecdUnit"("siteId");
ALTER TABLE "RecdUnit" ADD CONSTRAINT "RecdUnit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecdUnit" ADD CONSTRAINT "RecdUnit_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecdUnit" ADD CONSTRAINT "RecdUnit_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecdUnit" ADD CONSTRAINT "RecdUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one unit per physical RECD on existing orders (single statement, runs once).
--  * The order's own product x quantity, then each line item x quantity.
--  * The first unit of every order keeps the order number as its serial - that value is
--    what customers already use as their "RECD Serial Number" (see HANDOVER s20), so
--    existing logins and printed references keep working.
--  * Every other unit gets a NULL serial = "serial pending" until someone enters it.
INSERT INTO "RecdUnit" ("id", "serialNo", "orderId", "siteId", "productId", "lineItemId", "updatedAt")
SELECT gen_random_uuid()::text,
       CASE WHEN x."src" = 0 AND x."n" = 1 THEN o."orderNumber" ELSE NULL END,
       o."id", s."id", x."productId", x."lineItemId", CURRENT_TIMESTAMP
FROM (
  SELECT o2."id" AS "orderId", o2."productId", NULL::text AS "lineItemId", 0 AS "src", gs AS "n"
  FROM "Order" o2, LATERAL generate_series(1, GREATEST(o2."quantity", 1)) gs
  UNION ALL
  SELECT li."orderId", li."productId", li."id", 1, gs
  FROM "OrderLineItem" li, LATERAL generate_series(1, GREATEST(li."quantity", 1)) gs
) x
JOIN "Order" o ON o."id" = x."orderId"
LEFT JOIN "Site" s ON s."orderId" = o."id";

-- User audit log
CREATE TABLE "UserAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "targetUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UserAuditLog_targetUserId_createdAt_idx" ON "UserAuditLog"("targetUserId", "createdAt");
ALTER TABLE "UserAuditLog" ADD CONSTRAINT "UserAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserAuditLog" ADD CONSTRAINT "UserAuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS posture matches every other table: enabled, zero policies (app connects as owner via Prisma).
ALTER TABLE "Region" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RegionManager" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecdUnit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserAuditLog" ENABLE ROW LEVEL SECURITY;

-- Permission: manage_regions (granted to the same roles that hold ALL_PERMISSIONS minus settings)
INSERT INTO "Permission" ("id", "key", "name")
SELECT gen_random_uuid()::text, 'manage_regions', 'Manage regions and regional managers'
WHERE NOT EXISTS (SELECT 1 FROM "Permission" WHERE "key" = 'manage_regions');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r, "Permission" p
WHERE r."key" IN ('super_admin', 'owner_admin', 'management') AND p."key" = 'manage_regions'
ON CONFLICT DO NOTHING;

-- New roles
INSERT INTO "Role" ("id", "key", "name", "description")
SELECT gen_random_uuid()::text, v.key, v.name, v.descr FROM (VALUES
  ('regional_manager', 'Regional Manager', 'Owns service activity for the regions mapped to them: receives reminders and escalations for their regions.'),
  ('service_manager',  'Service Manager',  'Runs the service desk: manages and assigns customer tickets.'),
  ('service_engineer', 'Service Engineer', 'Field service engineer: works tickets assigned to them.')
) AS v(key, name, descr)
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE "Role"."key" = v.key);

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r JOIN "Permission" p ON TRUE
WHERE (r."key", p."key") IN (
  ('regional_manager', 'view_site_status'), ('regional_manager', 'manage_complaints'),
  ('regional_manager', 'view_complaints_overview'), ('regional_manager', 'view_dashboard'),
  ('service_manager',  'view_site_status'), ('service_manager',  'manage_complaints'),
  ('service_manager',  'view_complaints_overview'), ('service_manager', 'view_dashboard'),
  ('service_engineer', 'view_site_status'), ('service_engineer', 'act_assigned_complaints')
)
ON CONFLICT DO NOTHING;
