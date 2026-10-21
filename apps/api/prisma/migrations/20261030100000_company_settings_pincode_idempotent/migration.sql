-- Schema integrity: "CompanySettings"."pinCode" is in schema.prisma and exists in the shared (Supabase) database, where it was added out of band
-- (see the note in 20260825120000_port_zan_nonfinance, which deliberately did not add it). No migration ever created it, so a database built
-- from the migrations alone (a new environment, a restore-test, CI) lacked the column and the letterhead / settings code that reads it failed.
-- IF NOT EXISTS makes this a no-op wherever the column already exists (production) and creates it everywhere else. Nothing is dropped or changed.
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "pinCode" TEXT;
