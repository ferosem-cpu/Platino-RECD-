-- Link AMC orders to the RECD units they cover (many units per AMC order).
-- Purely additive: existing AMC orders simply have no linked units until staff add them.

CREATE TABLE "AmcOrderUnit" (
    "amcOrderId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmcOrderUnit_pkey" PRIMARY KEY ("amcOrderId","unitId")
);

CREATE INDEX "AmcOrderUnit_unitId_idx" ON "AmcOrderUnit"("unitId");

ALTER TABLE "AmcOrderUnit" ADD CONSTRAINT "AmcOrderUnit_amcOrderId_fkey" FOREIGN KEY ("amcOrderId") REFERENCES "AmcOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AmcOrderUnit" ADD CONSTRAINT "AmcOrderUnit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS posture matches every other table: enabled, zero policies (app connects as owner via Prisma).
ALTER TABLE "AmcOrderUnit" ENABLE ROW LEVEL SECURITY;
