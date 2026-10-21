// An in-memory stand-in for the IpRateLimit table, shaped like the single atomic upsert-and-increment the limiter issues
// (INSERT ... ON CONFLICT DO UPDATE ... RETURNING count). Each call is one synchronous step, as the real statement is atomic in
// PostgreSQL. It proves the limiter's logic and lets every API instance in a test share one store; it does NOT prove the SQL itself -
// test/db/ipRateLimit.db.test.ts runs the real statement against the isolated test database.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface FakeRateLimitStore {
  rows: Map<string, number>;
  /** When true every statement throws, like an unreachable database. */
  failing: boolean;
  statements: number;
  reset(): void;
  install(prisma: any): void;
}

export function createFakeRateLimitStore(): FakeRateLimitStore {
  const store: FakeRateLimitStore = {
    rows: new Map(),
    failing: false,
    statements: 0,
    reset() {
      store.rows.clear();
      store.failing = false;
      store.statements = 0;
    },
    install(prisma: any) {
      const queryRaw = async (_strings: TemplateStringsArray, keyHash: string, windowStart: Date) => {
        store.statements++;
        if (store.failing) throw new Error("database unavailable");
        const key = `${keyHash}|${windowStart.getTime()}`;
        const next = (store.rows.get(key) ?? 0) + 1;
        store.rows.set(key, next);
        return [{ count: next }];
      };
      Object.defineProperty(prisma, "$queryRaw", { configurable: true, value: queryRaw });
      Object.defineProperty(prisma, "ipRateLimit", { configurable: true, value: { deleteMany: async () => ({ count: 0 }) } });
    },
  };
  return store;
}
