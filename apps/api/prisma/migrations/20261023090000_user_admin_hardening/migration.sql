-- Requirement 10: user administration hardening. ADDITIVE ONLY: no user is changed, renamed, merged or deleted.

-- 1. Session revocation. Every existing user starts at version 0, and a token issued before this migration carries no version (read as 0),
--    so nobody is signed out by deploying it.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- 2. E-mail identity is case- and whitespace-insensitive. The existing exact-match unique index ("User_email_key") is KEPT; this adds the
--    normalised one next to it so "A@x.com", "a@x.com" and " a@x.com " cannot coexist however they are inserted (concurrent requests,
--    other routes, SQL). It cannot be expressed in the Prisma schema, so it lives here (same approach as the R7 partial unique indexes).
--    If the database already holds two accounts that differ only by case / surrounding spaces the index cannot be built: the check
--    below stops the migration with a clear message and changes NOTHING. The accounts must then be reconciled by hand (they are never
--    merged or renamed automatically).
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT lower(btrim("email")) FROM "User" WHERE "email" IS NOT NULL GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'User.email has % case-insensitive duplicate group(s); reconcile them manually before applying this migration (query: select lower(btrim(email)), count(*) from "User" where email is not null group by 1 having count(*) > 1)', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "User_email_normalized_key" ON "User" (lower(btrim("email"))) WHERE "email" IS NOT NULL;
