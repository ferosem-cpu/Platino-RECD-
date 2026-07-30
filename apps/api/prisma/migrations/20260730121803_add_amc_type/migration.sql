-- AMC Order: AMC Type (CAMC / NAMC), shown as a column in the AMC Order List
ALTER TABLE "AmcOrder" ADD COLUMN "amcType" TEXT NOT NULL DEFAULT 'camc';
