-- Service module phase 2: tickets tied to a physical RECD unit (one open ticket per unit),
-- reporter details for tickets raised by resellers/re-resellers, and the OTP table behind the
-- public "serial number + mobile + OTP" complaint flow.

ALTER TABLE "Complaint" ADD COLUMN "unitId" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'portal';
ALTER TABLE "Complaint" ADD COLUMN "reporterName" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "reporterPhone" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "reporterType" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "reporterVerifiedAt" TIMESTAMP(3);
CREATE INDEX "Complaint_unitId_idx" ON "Complaint"("unitId");
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "RecdUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hard guarantee behind the application check: a unit can have only one ticket that is not
-- resolved/closed. (Partial index - Prisma's schema language cannot express it, so it only
-- lives here. Do not drop it when "fixing" drift.)
CREATE UNIQUE INDEX "Complaint_one_open_per_unit"
  ON "Complaint" ("unitId")
  WHERE "unitId" IS NOT NULL AND "status" NOT IN ('resolved', 'closed');

CREATE TABLE "PublicOtp" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "serialNorm" TEXT NOT NULL,
    "unitId" TEXT,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "sessionHash" TEXT,
    "sessionExpiresAt" TIMESTAMP(3),
    "sessionUsedAt" TIMESTAMP(3),
    "deliveryChannel" TEXT NOT NULL DEFAULT 'none',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'skipped',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicOtp_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublicOtp_sessionHash_key" ON "PublicOtp"("sessionHash");
CREATE INDEX "PublicOtp_phone_createdAt_idx" ON "PublicOtp"("phone", "createdAt");
CREATE INDEX "PublicOtp_serialNorm_createdAt_idx" ON "PublicOtp"("serialNorm", "createdAt");
CREATE INDEX "PublicOtp_ip_createdAt_idx" ON "PublicOtp"("ip", "createdAt");

ALTER TABLE "PublicOtp" ENABLE ROW LEVEL SECURITY;
