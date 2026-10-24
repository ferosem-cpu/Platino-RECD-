// Seed security rules (prisma/seedAccounts.ts): no known default credential, no demo accounts outside a local database, a secure bootstrap
// Super Admin on production-like databases, refusal BEFORE any write, and re-running never resets an existing account.
// The rules run against an in-memory database; password hashing is replaced by a deterministic stand-in so the tests stay fast.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROLE_KEY } from "@recd/shared";
import {
  KNOWN_WEAK_PASSWORDS,
  SAMPLE_STAFF_EMAILS,
  SeedRefusedError,
  classifySeedTarget,
  ensureSampleUser,
  isLocalDatabaseUrl,
  planSeed,
  seedAccounts,
  seedPasswordProblem,
  type SeedDb,
} from "../prisma/seedAccounts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const hash = async (p: string) => `h(${p})`;
const compare = async (plain: string, h: string) => h === `h(${plain})`;

const ROLES = Object.values(ROLE_KEY).map((key) => ({ id: `role-${key}`, key }));
const roleKeyOf = (roleId: string) => ROLES.find((r) => r.id === roleId)!.key;

interface Row { id: string; name: string; email: string | null; passwordHash: string | null; roleId: string; isActive: boolean; mustChangePassword: boolean; title?: string }
function fakeDb(initial: Row[] = []) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const log = { writes: 0, creates: [] as Row[] };
  let n = 100;
  const db: SeedDb = {
    user: {
      count: async ({ where }: any) => rows.filter((r) => roleKeyOf(r.roleId) === where.role.key).length,
      findUnique: async ({ where }: any) => rows.find((r) => r.email === where.email) ?? null,
      findMany: async ({ where }: any) => rows.filter((r) => where.email.in.includes(r.email)).map((r) => ({ email: r.email, passwordHash: r.passwordHash })),
      create: async ({ data }: any) => { log.writes++; const row: Row = { id: `u${n++}`, name: data.name, email: data.email, passwordHash: data.passwordHash ?? null, roleId: data.roleId, isActive: data.isActive, mustChangePassword: data.mustChangePassword, title: data.title }; rows.push(row); log.creates.push(row); return { id: row.id }; },
      update: async ({ where, data }: any) => { log.writes++; Object.assign(rows.find((r) => r.id === where.id)!, data); return {}; },
    },
    role: { findMany: async () => ROLES },
  };
  return { db, rows, log };
}

const LOCAL = { NODE_ENV: "development", DATABASE_URL: "postgresql://postgres:postgres@localhost:5434/platino_test", DIRECT_URL: "postgresql://postgres:postgres@localhost:5434/platino_test" } as NodeJS.ProcessEnv;
const PROD = { NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@db.example.supabase.co:5432/postgres" } as NodeJS.ProcessEnv;
const STRONG = "Correct-Horse-Battery-42";
const BOOT = { SEED_SUPER_ADMIN_EMAIL: "boss@company.example", SEED_SUPER_ADMIN_PASSWORD: STRONG } as NodeJS.ProcessEnv;
const superAdminRow = (over: Partial<Row> = {}): Row => ({ id: "sa", name: "Real Admin", email: "real@company.example", passwordHash: "h(real-secret-9)", roleId: "role-super_admin", isActive: true, mustChangePassword: false, ...over });

// ---- target classification -----------------------------------------------------------------------------------------------------------

test("only a local database outside production counts as a development target; everything else is protected", () => {
  assert.deepEqual(classifySeedTarget(LOCAL), { protectedTarget: false, sampleData: true });
  assert.equal(classifySeedTarget({ ...LOCAL, SEED_SAMPLE_DATA: "0" }).sampleData, false, "demo data can be switched off locally");
  for (const env of [
    PROD,
    { ...LOCAL, NODE_ENV: "production" },
    { ...LOCAL, VERCEL: "1" },
    { ...LOCAL, VERCEL_ENV: "production" },
    { NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@db.example.supabase.co:5432/postgres" },
    { NODE_ENV: "development" }, // no database URL visible at all: assume the worst
    { ...LOCAL, DIRECT_URL: "postgresql://u:p@db.example.supabase.co:5432/postgres" }, // local pooled URL but a remote direct URL
  ] as NodeJS.ProcessEnv[]) {
    assert.deepEqual(classifySeedTarget(env), { protectedTarget: true, sampleData: false }, JSON.stringify(Object.keys(env)));
  }
});

test("isLocalDatabaseUrl: lookalike hosts, garbage and missing values are not local", () => {
  for (const ok of ["postgresql://u:p@localhost:5434/x", "postgresql://u:p@127.0.0.1/x", "postgresql://u:p@[::1]:5432/x", "postgresql://u:p@LOCALHOST/x"]) assert.equal(isLocalDatabaseUrl(ok), true, ok);
  for (const bad of ["postgresql://u:p@localhost.evil.com:5432/x", "postgresql://u:p@127.0.0.1.nip.io/x", "postgresql://u:p@db.prod.example/x", "not a url", "", undefined]) assert.equal(isLocalDatabaseUrl(bad as any), false, String(bad));
});

// ---- password policy -----------------------------------------------------------------------------------------------------------------

test("seed password policy: weak, short, predictable and e-mail-derived passwords are refused; the problem text never contains the password", () => {
  for (const w of [...KNOWN_WEAK_PASSWORDS, "CHANGEME123", "Changeme123!!", "short1", "onlyletterslongenough", "123456789012345", "boss-password-1!"]) {
    const problem = seedPasswordProblem(w, "boss@company.example");
    assert.ok(problem, w);
    assert.equal(problem!.includes(w), false, "the message does not echo the password");
  }
  assert.ok(seedPasswordProblem("boss-Strong-77-x", "boss@company.example"), "contains the e-mail name");
  assert.equal(seedPasswordProblem(STRONG, "boss@company.example"), null);
  assert.ok(seedPasswordProblem(undefined));
});

// ---- production / protected targets ----------------------------------------------------------------------------------------------------

test("production seeding is refused - before anything is written - when no Super Admin exists and no secure bootstrap is configured", async () => {
  const { db, log } = fakeDb();
  for (const env of [PROD, { ...PROD, SEED_SUPER_ADMIN_EMAIL: "boss@company.example" }, { ...PROD, SEED_SUPER_ADMIN_PASSWORD: STRONG }, { ...PROD, SEED_SUPER_ADMIN_EMAIL: "not-an-email", SEED_SUPER_ADMIN_PASSWORD: STRONG }] as NodeJS.ProcessEnv[]) {
    await assert.rejects(planSeed(db, env, compare), (e: unknown) => e instanceof SeedRefusedError);
  }
  assert.equal(log.writes, 0);
});

test("production seeding is refused for a weak bootstrap password (including the old default), and the refusal never prints it", async () => {
  const { db, log } = fakeDb();
  for (const pw of ["changeme123", "Short1", "alllettersnodigits", STRONG.toLowerCase().replace(/-/g, "") + "boss"]) {
    await assert.rejects(planSeed(db, { ...PROD, ...BOOT, SEED_SUPER_ADMIN_PASSWORD: pw }, compare), (e: Error) => {
      assert.ok(e instanceof SeedRefusedError);
      assert.equal(e.message.includes(pw), false, "message does not contain the password");
      return true;
    });
  }
  assert.equal(log.writes, 0);
});

test("production with a secure bootstrap creates exactly one Super Admin that must change its password, and no demo account or default credential", async () => {
  const { db, rows, log } = fakeDb();
  const plan = await planSeed(db, { ...PROD, ...BOOT }, compare);
  assert.equal(plan.sampleData, false);
  assert.equal(plan.protectedTarget, true);
  const summary = await seedAccounts(db, plan, hash);
  assert.deepEqual(summary, { bootstrapAdminCreated: true, sampleAccountsCreated: 0, passwordsInitialised: 0 });
  assert.equal(rows.length, 1);
  const admin = rows[0];
  assert.equal(roleKeyOf(admin.roleId), ROLE_KEY.SUPER_ADMIN);
  assert.equal(admin.email, "boss@company.example");
  assert.equal(admin.mustChangePassword, true, "the bootstrap secret must be replaced at first sign-in");
  assert.equal(admin.passwordHash, `h(${STRONG})`);
  assert.notEqual(admin.passwordHash, "h(changeme123)", "never the old well-known default");
  assert.equal(rows.some((r) => SAMPLE_STAFF_EMAILS.includes(r.email ?? "")), false, "no demo account");
  // the summary (the only thing the seed prints) carries counts and flags, never a password, hash or e-mail
  assert.equal(JSON.stringify(summary).includes(STRONG), false);
  assert.equal(log.creates.length, 1);
});

test("production re-run: an existing Super Admin is never reset - no bootstrap needed, nothing created, nothing changed", async () => {
  const existing = superAdminRow({ isActive: false, mustChangePassword: false });
  const { db, rows, log } = fakeDb([existing]);
  const plan = await planSeed(db, PROD, compare); // no bootstrap variables at all, and that is fine
  assert.equal(plan.bootstrap, null);
  assert.deepEqual(await seedAccounts(db, plan, hash), { bootstrapAdminCreated: false, sampleAccountsCreated: 0, passwordsInitialised: 0 });
  assert.equal(log.writes, 0);
  assert.deepEqual(rows[0], existing, "the deactivated admin stays deactivated, its password untouched");

  // even if the bootstrap variables are present and a Super Admin already exists, no second admin appears and nothing is overwritten
  const again = await planSeed(db, { ...PROD, ...BOOT }, compare);
  assert.equal(again.bootstrap, null);
  await seedAccounts(db, again, hash);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], existing);
});

test("a concurrent bootstrap cannot create a second Super Admin or overwrite one that appeared meanwhile", async () => {
  const { db, rows } = fakeDb();
  const plan = await planSeed(db, { ...PROD, ...BOOT }, compare);
  rows.push(superAdminRow()); // someone else created the first admin between planning and writing
  const summary = await seedAccounts(db, plan, hash);
  assert.equal(summary.bootstrapAdminCreated, false);
  assert.equal(rows.length, 1);
});

test("demo accounts can never be forced onto a production-like or remote database", async () => {
  const { db, log } = fakeDb([superAdminRow()]);
  for (const env of [{ ...PROD, SEED_SAMPLE_DATA: "1" }, { ...LOCAL, VERCEL: "1", SEED_SAMPLE_DATA: "1" }, { NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@remote.example/x", SEED_SAMPLE_DATA: "1" }] as NodeJS.ProcessEnv[]) {
    await assert.rejects(planSeed(db, env, compare), SeedRefusedError);
  }
  assert.equal(log.writes, 0);
});

test("a protected database that still holds an account with the OLD well-known password is refused until it is rotated", async () => {
  const legacy: Row = { id: "old", name: "Super Admin", email: "superadmin@platino.example", passwordHash: "h(changeme123)", roleId: "role-super_admin", isActive: true, mustChangePassword: false };
  const { db, rows, log } = fakeDb([legacy]);
  await assert.rejects(planSeed(db, { ...PROD, ...BOOT }, compare), (e: Error) => e instanceof SeedRefusedError && !e.message.includes("changeme123"));
  assert.equal(log.writes, 0);
  // once the password has been rotated the seed runs again
  rows[0].passwordHash = "h(a-rotated-secret-77)";
  await planSeed(db, PROD, compare);
});

// ---- local development / test workflow ---------------------------------------------------------------------------------------------------

test("local development: demo accounts are created, with the password from SEED_DEV_PASSWORD - and with NO password when it is unset (there is no built-in default)", async () => {
  const withPw = fakeDb();
  const plan = await planSeed(withPw.db, { ...LOCAL, SEED_DEV_PASSWORD: STRONG }, compare);
  assert.equal(plan.sampleData, true);
  const summary = await seedAccounts(withPw.db, plan, hash);
  assert.equal(summary.sampleAccountsCreated, SAMPLE_STAFF_EMAILS.length);
  assert.equal(withPw.rows.some((r) => roleKeyOf(r.roleId) === ROLE_KEY.SUPER_ADMIN && r.email === "superadmin@platino.example"), true, "the account the database tests rely on is there");
  for (const r of withPw.rows) {
    assert.equal(r.passwordHash, `h(${STRONG})`);
    assert.equal(r.mustChangePassword, false, "disposable local fixtures do not force a change");
  }

  const noPw = fakeDb();
  const plan2 = await planSeed(noPw.db, LOCAL, compare);
  await seedAccounts(noPw.db, plan2, hash);
  assert.equal(noPw.rows.length, SAMPLE_STAFF_EMAILS.length);
  for (const r of noPw.rows) assert.equal(r.passwordHash, null, "created without any password");
  for (const r of [...withPw.rows, ...noPw.rows]) assert.notEqual(r.passwordHash, "h(changeme123)");
});

test("local development: a weak SEED_DEV_PASSWORD (including the old default) is refused rather than silently used", async () => {
  const { db, log } = fakeDb();
  for (const pw of ["changeme123", "short1"]) {
    await assert.rejects(planSeed(db, { ...LOCAL, SEED_DEV_PASSWORD: pw }, compare), SeedRefusedError);
  }
  assert.equal(log.writes, 0);
});

test("repeated seeding never resets an existing account: password, role, active flag and name stay exactly as they are", async () => {
  const { db, rows, log } = fakeDb();
  await seedAccounts(db, await planSeed(db, { ...LOCAL, SEED_DEV_PASSWORD: STRONG }, compare), hash);
  // an administrator then changes things deliberately
  const admin = rows.find((r) => r.email === "superadmin@platino.example")!;
  const sales = rows.find((r) => r.email === "sales@platino.example")!;
  Object.assign(admin, { passwordHash: "h(my-own-new-secret-1)", mustChangePassword: false, name: "Renamed Admin" });
  Object.assign(sales, { isActive: false, roleId: "role-management", passwordHash: "h(sales-new-secret-2)" });
  const snapshot = JSON.stringify(rows);
  log.writes = 0;

  const second = await seedAccounts(db, await planSeed(db, { ...LOCAL, SEED_DEV_PASSWORD: "Another-Strong-Pass-55" }, compare), hash);
  assert.deepEqual(second, { bootstrapAdminCreated: false, sampleAccountsCreated: 0, passwordsInitialised: 0 });
  assert.equal(log.writes, 0, "not a single write");
  assert.equal(JSON.stringify(rows), snapshot);
});

test("a password is only ever INITIALISED on an account that has none - never replaced", async () => {
  const { db, rows } = fakeDb();
  await seedAccounts(db, await planSeed(db, LOCAL, compare), hash); // all created without a password
  const withOwn = rows.find((r) => r.email === "owner@platino.example")!;
  withOwn.passwordHash = "h(owner-chose-this-7)";
  const summary = await seedAccounts(db, await planSeed(db, { ...LOCAL, SEED_DEV_PASSWORD: STRONG }, compare), hash);
  assert.equal(summary.passwordsInitialised, SAMPLE_STAFF_EMAILS.length - 1);
  assert.equal(withOwn.passwordHash, "h(owner-chose-this-7)", "the account that already had a password keeps it");
  assert.equal(rows.find((r) => r.email === "superadmin@platino.example")!.passwordHash, `h(${STRONG})`);
});

test("ensureSampleUser leaves an existing account untouched (role / active flag), and returns what it did", async () => {
  const { db, rows } = fakeDb([{ id: "c", name: "Cust", email: "customer@sundaram.example", passwordHash: null, roleId: "role-customer", isActive: false, mustChangePassword: true }]);
  const r = await ensureSampleUser(db, { name: "Other", email: "customer@sundaram.example", roleId: "role-super_admin" }, null);
  assert.deepEqual(r, { created: false, passwordInitialised: false });
  assert.deepEqual(rows[0], { id: "c", name: "Cust", email: "customer@sundaram.example", passwordHash: null, roleId: "role-customer", isActive: false, mustChangePassword: true });
});

// ---- the code itself -----------------------------------------------------------------------------------------------------------------

test("the seed script contains no hard-coded password and prints no credential", () => {
  const seed = readFileSync(path.join(__dirname, "..", "prisma", "seed.ts"), "utf8");
  const accounts = readFileSync(path.join(__dirname, "..", "prisma", "seedAccounts.ts"), "utf8");
  assert.equal(/changeme/i.test(seed), false, "seed.ts has no default password");
  assert.equal(/bcrypt/.test(seed), false, "seed.ts hashes nothing itself");
  // the only mention of the old default in seedAccounts.ts is the denylist / legacy-detection constants
  const mentions = accounts.split("\n").filter((l) => /changeme/i.test(l));
  assert.ok(mentions.length > 0 && mentions.every((l) => /KNOWN_WEAK_PASSWORDS|LEGACY_DEFAULT_PASSWORD|"changeme/.test(l) || l.trim().startsWith("*") || l.trim().startsWith("//")), mentions.join("\n"));
  // every console call in the seed prints fixed text, a count or a boolean
  for (const line of seed.split("\n").filter((l) => /console\.(log|error|warn)/.test(l))) assert.equal(/password|hash|secret|token/i.test(line.replace(/SEED_DEV_PASSWORD/g, "")), false, line);
});
