-- Login OTP hardening (Requirement 3). FOR REVIEW - not applied to any shared or production database.
--
-- Why:
--  * purpose        - a code issued for one login flow cannot be used for another.
--  * destination    - the mobile number the code was delivered to; verification must present the same number.
--  * attempts       - wrong guesses are counted in the database (atomically), so the limit holds across
--                     server instances and cannot be reset by requesting another code.
--  * deliveryStatus - a failed WhatsApp delivery does not count towards the resend cooldown.
--  * unique index   - at most ONE unconsumed code per user and purpose. Two simultaneous requests cannot
--                     leave two usable codes behind; the loser gets a "wait" answer.
-- All new columns are nullable or have defaults, so existing rows stay valid (old rows are 10-minute codes
-- and will simply expire; they are voided below so the unique index can be created).

ALTER TABLE "OtpCode" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'customer_login';
ALTER TABLE "OtpCode" ADD COLUMN "destination" TEXT;
ALTER TABLE "OtpCode" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OtpCode" ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'pending';

-- Codes issued before this migration were emailed under the old rules; void any still unconsumed.
UPDATE "OtpCode" SET "consumedAt" = NOW() WHERE "consumedAt" IS NULL;

CREATE INDEX "OtpCode_userId_purpose_createdAt_idx" ON "OtpCode"("userId", "purpose", "createdAt");

CREATE UNIQUE INDEX "OtpCode_one_active_per_user_purpose" ON "OtpCode"("userId", "purpose") WHERE "consumedAt" IS NULL;
