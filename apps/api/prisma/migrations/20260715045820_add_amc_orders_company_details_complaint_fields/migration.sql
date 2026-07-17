-- Site: customer-filled "Company Details" form fields
ALTER TABLE "Site" ADD COLUMN "companyName" TEXT;
ALTER TABLE "Site" ADD COLUMN "sitePocName" TEXT;
ALTER TABLE "Site" ADD COLUMN "sitePocNumber" TEXT;

-- Complaint: issue category picker, customer attachment, staff remarks + service report
ALTER TABLE "Complaint" ADD COLUMN "issueCategory" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "attachmentUrl" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "remarks" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "serviceReportUrl" TEXT;

-- AMC (Annual Maintenance Contract) orders
CREATE TABLE "AmcOrder" (
    "id" TEXT NOT NULL,
    "poNo" TEXT NOT NULL,
    "poDate" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amcFrequencyPerYear" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'yet_to_start',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmcOrder_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AmcOrder" ADD CONSTRAINT "AmcOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AmcOrder" ADD CONSTRAINT "AmcOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
