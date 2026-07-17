-- AMC Order: expiry reminder tracking (poDate + 1 year, reminded every 3 days until cleared)
ALTER TABLE "AmcOrder" ADD COLUMN "lastExpiryReminderAt" TIMESTAMP(3);
ALTER TABLE "AmcOrder" ADD COLUMN "expiryReminderClearedAt" TIMESTAMP(3);
ALTER TABLE "AmcOrder" ADD COLUMN "expiryReminderClearedById" TEXT;

ALTER TABLE "AmcOrder" ADD CONSTRAINT "AmcOrder_expiryReminderClearedById_fkey" FOREIGN KEY ("expiryReminderClearedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
