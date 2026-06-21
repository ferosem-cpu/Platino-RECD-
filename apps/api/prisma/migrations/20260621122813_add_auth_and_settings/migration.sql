-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "logoDataUrl" TEXT,
    "themeKey" TEXT NOT NULL DEFAULT 'emerald',
    "customColors" JSONB,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);
