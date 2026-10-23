// Stand-in for prisma.$transaction in the mocked suites. It also emulates the advisory locks of lib/advisoryLock.ts
// (pg_advisory_xact_lock) in a deliberately COARSER way than PostgreSQL: a transaction that asks for any advisory lock
// holds ONE global lock until it finishes, so transactions that lock run strictly one after another. That is enough
// to test the application logic that depends on the lock ("count, then insert" cannot interleave) with real request
// concurrency. It does not prove the per-key behaviour of PostgreSQL - the real-database suites (test/db) do that.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function installFakeTransactions(prisma: any): void {
  let busy = false;
  const waiting: Array<() => void> = [];

  const lock = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!busy) {
        busy = true;
        resolve();
      } else {
        waiting.push(resolve); // ownership is handed over directly by unlock()
      }
    });
  const unlock = (): void => {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  };

  Object.defineProperty(prisma, "$transaction", {
    configurable: true,
    writable: true,
    value: async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      const state = { holding: false };
      const tx = Object.create(prisma);
      // defineProperty, not assignment: PrismaClient is a Proxy, and an assignment on an object inheriting from it would overwrite the
      // shared client's method instead of giving this transaction its own.
      Object.defineProperty(tx, "$executeRaw", {
        value: async (strings: TemplateStringsArray) => {
          if (/pg_advisory_xact_lock/.test(strings.join("")) && !state.holding) {
            await lock();
            state.holding = true;
          }
          return 0;
        },
      });
      try {
        return await arg(tx);
      } finally {
        if (state.holding) unlock();
      }
    },
  });
}
