-- Requirement 3: shared per-IP request limiter. ADDITIVE ONLY: one new table; no existing row or table is changed.
-- "keyHash" is a keyed hash of the limiter name and client address; the address itself is never stored.

-- CreateTable
CREATE TABLE "IpRateLimit" (
    "keyHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IpRateLimit_pkey" PRIMARY KEY ("keyHash", "windowStart")
);

-- CreateIndex
CREATE INDEX "IpRateLimit_windowStart_idx" ON "IpRateLimit"("windowStart");

ALTER TABLE "IpRateLimit" ADD CONSTRAINT "IpRateLimit_count_check" CHECK ("count" >= 0);

-- Same row-level-security posture as the other new tables (the API connects as the table owner).
ALTER TABLE "IpRateLimit" ENABLE ROW LEVEL SECURITY;
