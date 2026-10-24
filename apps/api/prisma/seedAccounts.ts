/**
 * Account provisioning rules for the database seed - kept separate from seed.ts so they can be tested without a database or the
 * seed's side effects.
 *
 * What the rules guarantee:
 *  - No account is ever created with a fixed, predictable password. There is no default password anywhere in the code.
 *  - Demo (sample) accounts are created ONLY on a local development / test database (localhost, outside production). Against any other
 *    database - production, staging, a remote host - the seed refuses them outright, even if asked.
 *  - On a protected (production-like or non-local) database the seed needs a securely supplied first Super Admin
 *    (SEED_SUPER_ADMIN_EMAIL + SEED_SUPER_ADMIN_PASSWORD, a strong password) whenever no Super Admin exists yet, and otherwise REFUSES
 *    to run - before it has written anything. The account is created with mustChangePassword = true.
 *  - Re-running the seed never changes an existing account's password, role, active flag or any other field. A password is only ever
 *    written to an account that has none at all (an initialisation, never a reset).
 *  - Passwords are never printed or logged; summaries carry counts only.
 */
import bcrypt from "bcryptjs";
import { ROLE_KEY } from "@recd/shared";

/** Passwords that must never be accepted for a seeded account. (Compared case-insensitively.) */
export const KNOWN_WEAK_PASSWORDS: readonly string[] = [
  "changeme123",
  "changeme",
  "password",
  "password123",
  "admin123",
  "admin@123",
  "12345678",
  "123456789012",
  "qwerty123456",
  "platino123",
  "platino@123",
];

/** The accounts the OLD seed created with the fixed password; used to detect an environment that still has them. */
export const LEGACY_DEFAULT_PASSWORD = "changeme123";
export const SAMPLE_STAFF_EMAILS: readonly string[] = [
  "superadmin@platino.example",
  "owner@platino.example",
  "management@platino.example",
  "sales@platino.example",
  "ops@platino.example",
  "erection@platino.example",
  "commissioning@platino.example",
  "service@platino.example",
  "finance@platino.example",
];

export const MIN_SEED_PASSWORD_LENGTH = 12;

export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefusedError";
  }
}

/** A problem with a proposed seed password (never echoing the password itself), or null when it is acceptable. */
export function seedPasswordProblem(password: string | undefined, email?: string): string | null {
  if (!password) return "is not set";
  if (password.length < MIN_SEED_PASSWORD_LENGTH) return `must be at least ${MIN_SEED_PASSWORD_LENGTH} characters long`;
  if (password.length > 200) return "is too long";
  const lower = password.toLowerCase();
  if (KNOWN_WEAK_PASSWORDS.some((w) => lower === w || lower.includes(w))) return "is a well-known weak password";
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return "must contain both letters and digits";
  if (email) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local && local.length >= 4 && lower.includes(local)) return "must not contain the account's e-mail name";
  }
  return null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/** True only when the URL is parseable and its host is this machine (the disposable local Docker database). */
export function isLocalDatabaseUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isProductionLike(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production" || !!env.VERCEL;
}

export interface SeedTarget {
  /** Demo accounts / sample order / sample vendors may be created. */
  sampleData: boolean;
  /** Production, hosted or non-local database: demo data is never allowed and a secure bootstrap is required. */
  protectedTarget: boolean;
}

export function classifySeedTarget(env: NodeJS.ProcessEnv): SeedTarget {
  const local = isLocalDatabaseUrl(env.DATABASE_URL) && (!env.DIRECT_URL || isLocalDatabaseUrl(env.DIRECT_URL));
  const protectedTarget = isProductionLike(env) || !local;
  return { protectedTarget, sampleData: !protectedTarget && env.SEED_SAMPLE_DATA !== "0" };
}

/** The slice of PrismaClient the account seeding uses (a fake with the same shape is used in tests). */
export interface SeedDb {
  user: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    findUnique(args: { where: { email: string }; select?: Record<string, boolean> }): Promise<{ id: string; passwordHash: string | null } | null>;
    findMany(args: { where: Record<string, unknown>; select?: Record<string, boolean> }): Promise<{ email: string | null; passwordHash: string | null }[]>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  role: {
    findMany(args?: Record<string, unknown>): Promise<{ id: string; key: string }[]>;
  };
}

export interface BootstrapAdmin {
  email: string;
  name: string;
  password: string;
}

export interface SeedPlan extends SeedTarget {
  superAdminExists: boolean;
  /** Present only when a first Super Admin must be created on a protected target. */
  bootstrap: BootstrapAdmin | null;
  /** The (validated) password for NEW demo accounts on a local database; null = demo accounts are created without a password. */
  devPassword: string | null;
}

/**
 * Decides what the seed may do and REFUSES (throws SeedRefusedError) when it must not run. Reads only - call it before any write.
 */
export async function planSeed(db: SeedDb, env: NodeJS.ProcessEnv, compare: (plain: string, hash: string) => Promise<boolean> = bcrypt.compare): Promise<SeedPlan> {
  const target = classifySeedTarget(env);
  if (target.protectedTarget && env.SEED_SAMPLE_DATA === "1") {
    throw new SeedRefusedError("SEED_SAMPLE_DATA=1 is refused: demo accounts can only be created on a local development database (localhost, outside production).");
  }

  const superAdminExists = (await db.user.count({ where: { role: { key: ROLE_KEY.SUPER_ADMIN } } })) > 0;

  if (target.protectedTarget) {
    // An environment that was seeded by the old version still holds known-password accounts: fail closed until they are rotated.
    const legacy = await db.user.findMany({ where: { email: { in: [...SAMPLE_STAFF_EMAILS] } }, select: { email: true, passwordHash: true } });
    for (const u of legacy) {
      if (u.passwordHash && (await compare(LEGACY_DEFAULT_PASSWORD, u.passwordHash))) {
        throw new SeedRefusedError(
          "Seeding refused: an existing account still uses the old well-known seed password. Reset the password of every seeded demo account " +
            "(or deactivate/delete them) and re-run. No passwords are shown here.",
        );
      }
    }

    if (!superAdminExists) {
      const email = (env.SEED_SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
      const password = env.SEED_SUPER_ADMIN_PASSWORD;
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new SeedRefusedError("Seeding refused: no Super Admin exists and SEED_SUPER_ADMIN_EMAIL is missing or not a valid e-mail address.");
      }
      const problem = seedPasswordProblem(password, email);
      if (problem) throw new SeedRefusedError(`Seeding refused: no Super Admin exists and SEED_SUPER_ADMIN_PASSWORD ${problem}.`);
      return { ...target, superAdminExists, bootstrap: { email, name: (env.SEED_SUPER_ADMIN_NAME ?? "").trim() || "Super Admin", password: password! }, devPassword: null };
    }
    return { ...target, superAdminExists, bootstrap: null, devPassword: null };
  }

  // Local development / test database: demo accounts are allowed; their password (if any) comes from the environment, never from the code.
  let devPassword: string | null = null;
  if (target.sampleData && env.SEED_DEV_PASSWORD) {
    const problem = seedPasswordProblem(env.SEED_DEV_PASSWORD);
    if (problem) throw new SeedRefusedError(`Seeding refused: SEED_DEV_PASSWORD ${problem}.`);
    devPassword = env.SEED_DEV_PASSWORD;
  }
  return { ...target, superAdminExists, bootstrap: null, devPassword };
}

export interface SeedAccountsSummary {
  bootstrapAdminCreated: boolean;
  sampleAccountsCreated: number;
  passwordsInitialised: number;
}

const SAMPLE_STAFF: { name: string; email: string; roleKey: string; title: string }[] = [
  { name: "Super Admin", email: "superadmin@platino.example", roleKey: ROLE_KEY.SUPER_ADMIN, title: "Super Admin" },
  { name: "Priya Sharma", email: "owner@platino.example", roleKey: ROLE_KEY.MANAGEMENT, title: "Proprietor" },
  { name: "Anil Mehta", email: "management@platino.example", roleKey: ROLE_KEY.MANAGEMENT, title: "Operations Head" },
  { name: "Rahul Verma", email: "sales@platino.example", roleKey: ROLE_KEY.SALES, title: "Sales Engineer" },
  { name: "Sunil Rao", email: "ops@platino.example", roleKey: ROLE_KEY.OPERATIONS_PM, title: "Project Manager" },
  { name: "Vikram Singh", email: "erection@platino.example", roleKey: ROLE_KEY.ERECTION_ENGINEER, title: "Erection Engineer" },
  { name: "Deepak Kumar", email: "commissioning@platino.example", roleKey: ROLE_KEY.COMMISSIONING_ENGINEER, title: "Commissioning Engineer" },
  { name: "Meena Iyer", email: "service@platino.example", roleKey: ROLE_KEY.SERVICE_TEAM, title: "Service Team" },
  { name: "Kavita Nair", email: "finance@platino.example", roleKey: ROLE_KEY.FINANCE, title: "Finance" },
];

/**
 * Creates the first Super Admin (protected targets) and/or the demo accounts (local databases). Idempotent and non-destructive:
 * an existing account is left exactly as it is; only an account with NO password at all may be given one.
 * The customer demo contact is created by seed.ts (it needs the customer row) through `ensureSampleUser`.
 */
export async function seedAccounts(
  db: SeedDb,
  plan: SeedPlan,
  hash: (plain: string) => Promise<string> = (p) => bcrypt.hash(p, 10),
): Promise<SeedAccountsSummary> {
  const summary: SeedAccountsSummary = { bootstrapAdminCreated: false, sampleAccountsCreated: 0, passwordsInitialised: 0 };
  const roles = new Map((await db.role.findMany()).map((r) => [r.key, r.id]));

  if (plan.bootstrap) {
    // Re-check at write time: a Super Admin may have appeared since planning (two deployments at once) - then do nothing.
    const stillNone = (await db.user.count({ where: { role: { key: ROLE_KEY.SUPER_ADMIN } } })) === 0;
    const roleId = roles.get(ROLE_KEY.SUPER_ADMIN);
    if (stillNone && roleId && !(await db.user.findUnique({ where: { email: plan.bootstrap.email } }))) {
      await db.user.create({
        data: {
          name: plan.bootstrap.name,
          email: plan.bootstrap.email,
          passwordHash: await hash(plan.bootstrap.password),
          title: "Super Admin",
          roleId,
          isActive: true,
          // The initial credential is a bootstrap secret held by whoever ran the seed: it must be replaced at first sign-in.
          mustChangePassword: true,
        },
      });
      summary.bootstrapAdminCreated = true;
    }
  }

  if (plan.sampleData) {
    const devHash = plan.devPassword ? await hash(plan.devPassword) : null;
    for (const u of SAMPLE_STAFF) {
      const roleId = roles.get(u.roleKey);
      if (!roleId) continue;
      const r = await ensureSampleUser(db, { name: u.name, email: u.email, title: u.title, roleId }, devHash);
      if (r.created) summary.sampleAccountsCreated += 1;
      if (r.passwordInitialised) summary.passwordsInitialised += 1;
    }
  }
  return summary;
}

/**
 * Demo account helper. NEVER updates an existing account except to give a password to one that has none.
 * Demo accounts do not force a password change (they are disposable local fixtures).
 */
export async function ensureSampleUser(
  db: SeedDb,
  data: { name: string; email: string; title?: string; phone?: string; roleId: string; customerId?: string },
  passwordHash: string | null,
): Promise<{ created: boolean; passwordInitialised: boolean }> {
  const existing = await db.user.findUnique({ where: { email: data.email } });
  if (existing) {
    if (!existing.passwordHash && passwordHash) {
      await db.user.update({ where: { id: existing.id }, data: { passwordHash } });
      return { created: false, passwordInitialised: true };
    }
    return { created: false, passwordInitialised: false };
  }
  await db.user.create({ data: { ...data, passwordHash, isActive: true, mustChangePassword: false } });
  return { created: true, passwordInitialised: !!passwordHash };
}
