// An in-memory stand-in for the OtpCode table that behaves like the real one where the OTP logic depends on it:
// filtering (equality, null, gt/gte/lt/not), atomic conditional updateMany with increment, aggregate sums, ordering,
// and the partial unique index "one unconsumed code per user and purpose" (P2002). Every operation yields to the
// event loop first, so requests running in parallel really interleave between their read and write steps.
//
// It proves the application logic. It does NOT prove the real database behaves the same - that is what the
// real-database suite (test/db/loginOtp.db.test.ts) is for.
import { Prisma } from "@prisma/client";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OtpRow {
  id: string;
  userId: string;
  code: string;
  purpose: string;
  destination: string | null;
  attempts: number;
  deliveryStatus: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const time = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));

export function matchesCondition(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date || typeof cond !== "object") return actual instanceof Date ? time(actual) === time(cond) : actual === cond;
  if ("gt" in cond && !(time(actual) > time(cond.gt))) return false;
  if ("gte" in cond && !(time(actual) >= time(cond.gte))) return false;
  if ("lt" in cond && !(actual < cond.lt)) return false;
  if ("not" in cond && actual === cond.not) return false;
  if ("in" in cond && !cond.in.includes(actual)) return false;
  return true;
}

export function createFakeOtpStore() {
  const rows: OtpRow[] = [];
  let seq = 0;

  const matches = (row: OtpRow, where: Record<string, any> = {}) => Object.entries(where).every(([k, cond]) => matchesCondition((row as any)[k], cond));
  const sorted = (list: OtpRow[], orderBy?: Record<string, "asc" | "desc">) => {
    if (!orderBy) return list;
    const [[field, dir]] = Object.entries(orderBy);
    return [...list].sort((a, b) => (time((a as any)[field]) - time((b as any)[field])) * (dir === "desc" ? -1 : 1));
  };
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0", meta: { modelName: "OtpCode", target: ["userId", "purpose"] } });

  const stub = {
    async create({ data }: any) {
      await tick();
      const row: OtpRow = {
        id: data.id ?? `fake${++seq}`,
        userId: data.userId,
        code: data.code,
        purpose: data.purpose ?? "customer_login",
        destination: data.destination ?? null,
        attempts: 0,
        deliveryStatus: data.deliveryStatus ?? "pending",
        expiresAt: data.expiresAt,
        consumedAt: null,
        createdAt: new Date(),
      };
      if (rows.some((r) => r.userId === row.userId && r.purpose === row.purpose && r.consumedAt === null)) throw p2002();
      rows.push(row);
      return { ...row };
    },
    async count({ where }: any) {
      await tick();
      return rows.filter((r) => matches(r, where)).length;
    },
    async findFirst({ where, orderBy }: any = {}) {
      await tick();
      const hit = sorted(rows.filter((r) => matches(r, where)), orderBy)[0];
      return hit ? { ...hit } : null;
    },
    async findMany({ where, orderBy, take }: any = {}) {
      await tick();
      return sorted(rows.filter((r) => matches(r, where)), orderBy).slice(0, take).map((r) => ({ ...r }));
    },
    async aggregate({ where }: any) {
      await tick();
      return { _sum: { attempts: rows.filter((r) => matches(r, where)).reduce((n, r) => n + r.attempts, 0) } };
    },
    async updateMany({ where, data }: any) {
      await tick();
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) {
        for (const [k, v] of Object.entries<any>(data)) {
          if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) (r as any)[k] += v.increment;
          else if (v && typeof v === "object" && !(v instanceof Date) && "decrement" in v) (r as any)[k] -= v.decrement;
          else (r as any)[k] = v;
        }
      }
      return { count: hit.length };
    },
  };

  return {
    stub,
    rows,
    /** Adds a row as the app would have stored it. */
    seed(partial: Partial<OtpRow> & Pick<OtpRow, "userId" | "code">): OtpRow {
      const row: OtpRow = {
        id: `seed${++seq}`,
        purpose: "customer_login",
        destination: null,
        attempts: 0,
        deliveryStatus: "sent",
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: null,
        createdAt: new Date(),
        ...partial,
      };
      rows.push(row);
      return row;
    },
    /** Pretends `ms` have passed for every row (creation time and expiry move back together). */
    age(ms: number) {
      for (const r of rows) {
        r.createdAt = new Date(r.createdAt.getTime() - ms);
        r.expiresAt = new Date(r.expiresAt.getTime() - ms);
      }
    },
    activeFor(userId: string, purpose?: string) {
      return rows.filter((r) => r.userId === userId && r.consumedAt === null && (!purpose || r.purpose === purpose));
    },
    clear() {
      rows.length = 0;
    },
  };
}
