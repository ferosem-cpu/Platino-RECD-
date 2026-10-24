-- Requirement 7: a Vendor AMC (our agreement WITH a vendor, who provides maintenance support) may record the customer and site
-- it applies to. ADDITIVE ONLY: two nullable columns, so every existing vendor contract stays valid (NULL = a general agreement
-- with the vendor) and nothing is backfilled or changed. ON DELETE SET NULL: deleting a customer or a site never deletes the
-- agreement or its renewal history. That the site belongs to the customer is checked by the API (it cannot be expressed here).

-- AlterTable
ALTER TABLE "VendorAmc" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "siteId" TEXT;

-- CreateIndex
CREATE INDEX "VendorAmc_customerId_idx" ON "VendorAmc"("customerId");

-- CreateIndex
CREATE INDEX "VendorAmc_siteId_idx" ON "VendorAmc"("siteId");

-- AddForeignKey
ALTER TABLE "VendorAmc" ADD CONSTRAINT "VendorAmc_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAmc" ADD CONSTRAINT "VendorAmc_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
