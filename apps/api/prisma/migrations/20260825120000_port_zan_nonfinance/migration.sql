-- Port of the non-finance schema additions from the Zan-APP fork (see HANDOVER.md §24).
-- Deliberately omits every finance-module table/column (quotations, invoices, purchase
-- orders, bills, expenses, work orders, suppliers, document sequences, saved line items,
-- per-customer pricing, HSN/SAC, GST/bank/signatory settings).

-- ---------------------------------------------------------------------------
-- Product: structure-sizing + silencer type
-- ---------------------------------------------------------------------------
ALTER TABLE "Product" ADD COLUMN "shape" TEXT;
ALTER TABLE "Product" ADD COLUMN "dimensions" TEXT;
ALTER TABLE "Product" ADD COLUMN "weightKg" DECIMAL(10,2);
ALTER TABLE "Product" ADD COLUMN "silencerType" INTEGER;

-- ---------------------------------------------------------------------------
-- Vendor archiving (deactivate without losing history)
-- ---------------------------------------------------------------------------
ALTER TABLE "Vendor" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_archivedById_fkey"
  FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Order: value/orderDate become optional (multi-site import creates operational
-- orders with no commercial figures yet)
-- ---------------------------------------------------------------------------
ALTER TABLE "Order" ALTER COLUMN "value" DROP NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "orderDate" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- OrderLineItem: additional RECD units on the same order/site
-- ---------------------------------------------------------------------------
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Site: Google Drive folders for photographs / drawings
-- ---------------------------------------------------------------------------
ALTER TABLE "Site" ADD COLUMN "photosDriveFolderId" TEXT;
ALTER TABLE "Site" ADD COLUMN "photosDriveFolderUrl" TEXT;
ALTER TABLE "Site" ADD COLUMN "drawingsDriveFolderId" TEXT;
ALTER TABLE "Site" ADD COLUMN "drawingsDriveFolderUrl" TEXT;

-- ---------------------------------------------------------------------------
-- Site contacts
-- ---------------------------------------------------------------------------
CREATE TABLE "SiteContact" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteContact_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SiteContact" ADD CONSTRAINT "SiteContact_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Site document requirements
-- ---------------------------------------------------------------------------
CREATE TABLE "DocumentRequirementType" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sequenceOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentRequirementType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentRequirementType_key_key" ON "DocumentRequirementType"("key");

CREATE TABLE "SiteDocumentRequirement" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "requirementTypeId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'not_submitted',
    "documentUrl" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteDocumentRequirement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SiteDocumentRequirement_siteId_requirementTypeId_key"
  ON "SiteDocumentRequirement"("siteId", "requirementTypeId");
ALTER TABLE "SiteDocumentRequirement" ADD CONSTRAINT "SiteDocumentRequirement_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteDocumentRequirement" ADD CONSTRAINT "SiteDocumentRequirement_requirementTypeId_fkey"
  FOREIGN KEY ("requirementTypeId") REFERENCES "DocumentRequirementType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RECD delivery tracking
-- ---------------------------------------------------------------------------
CREATE TABLE "RecdDelivery" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "statusNote" TEXT,
    "priority" INTEGER,
    "expectedDate" TIMESTAMP(3),
    "actualDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecdDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecdDelivery_siteId_key" ON "RecdDelivery"("siteId");
ALTER TABLE "RecdDelivery" ADD CONSTRAINT "RecdDelivery_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecdDelivery" ADD CONSTRAINT "RecdDelivery_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CompanySettings: letterhead identity (for DataTable print) + agent config
-- ---------------------------------------------------------------------------
ALTER TABLE "CompanySettings" ADD COLUMN "legalName" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "address" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "city" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "pinCode" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "email" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "website" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "phone" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "documentFooterNote" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "agentVisibleRoleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CompanySettings" ADD COLUMN "agentCustomInstructions" TEXT;

-- ---------------------------------------------------------------------------
-- In-app agent
-- ---------------------------------------------------------------------------
CREATE TABLE "AgentLlmProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "apiKeyCiphertext" TEXT NOT NULL,
    "baseUrl" TEXT,
    "model" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentLlmProvider_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AgentLlmProvider" ADD CONSTRAINT "AgentLlmProvider_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentConversation_userId_idx" ON "AgentConversation"("userId");
ALTER TABLE "AgentConversation" ADD CONSTRAINT "AgentConversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS: match every other table's posture in this database (enabled, zero policies -
-- default-deny to the anon key; the app's own Prisma connection bypasses RLS).
-- ---------------------------------------------------------------------------
ALTER TABLE "OrderLineItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentRequirementType" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteDocumentRequirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecdDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentLlmProvider" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentConversation" ENABLE ROW LEVEL SECURITY;
