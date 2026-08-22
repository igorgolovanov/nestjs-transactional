import { TypeOrmTransactionAdapter } from '../../src/adapter/typeorm.adapter';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';
import { TestUser } from '../shared/test-user.entity';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Barrier {
  readonly reached: Promise<void>;
  readonly reach: () => void;
}

/**
 * A one-shot barrier for ordering two concurrent transactions.
 *
 * The isolation properties below only hold while both transactions are
 * open at the same time, and sleeps can only *hope* for that overlap:
 * they encode a margin (one side sleeps 50 ms, the other 100 ms) that a
 * loaded CI runner can erase, at which point the transactions run one
 * after another and Postgres correctly reports what a serial execution
 * sees. That is a broken test, not a broken library. Barriers make the
 * interleaving each test needs the only one reachable.
 */
function barrier(): Barrier {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { reached, reach };
}

describe('TypeOrmTransactionAdapter (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;
  let adapter: TypeOrmTransactionAdapter;

  beforeAll(async () => {
    ctx = await startPostgresContainer({
      entities: [TestUser],
      synchronize: true,
    });
    adapter = new TypeOrmTransactionAdapter(ctx.dataSource, 'default');
  });

  afterAll(async () => {
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    await ctx.dataSource.getRepository(TestUser).clear();
  });

  it('Postgres MVCC: concurrent transactions run in isolation and both commit', async () => {
    let tx1InnerCount = -1;
    let tx2InnerCount = -1;

    // Postgres takes a REPEATABLE READ snapshot at the transaction's
    // first statement, not at BEGIN. So the order that has to be forced
    // is: tx1 writes, then tx2 writes (taking its snapshot while tx1 is
    // still uncommitted), then both count.
    const tx1HasWritten = barrier();
    const tx2HasCounted = barrier();

    await Promise.all([
      adapter.runInTransaction({ isolation: 'REPEATABLE_READ' }, async (h) => {
        await h.entityManager.save(TestUser, { name: 'tx1' });
        tx1HasWritten.reach();
        await tx2HasCounted.reached;
        // With REPEATABLE READ snapshot isolation, tx1 sees only its own
        // write — its snapshot predates tx2's insert, so this holds
        // whether or not tx2 has committed by now.
        tx1InnerCount = await h.entityManager.getRepository(TestUser).count();
      }),
      adapter.runInTransaction({ isolation: 'REPEATABLE_READ' }, async (h) => {
        await tx1HasWritten.reached;
        try {
          await h.entityManager.save(TestUser, { name: 'tx2' });
          tx2InnerCount = await h.entityManager.getRepository(TestUser).count();
        } finally {
          // Released in `finally` so a failure here surfaces as that
          // failure rather than as tx1 waiting out the test timeout.
          tx2HasCounted.reach();
        }
      }),
    ]);

    expect(tx1InnerCount).toBe(1);
    expect(tx2InnerCount).toBe(1);

    const names = (await ctx.dataSource.getRepository(TestUser).find()).map((u) => u.name).sort();
    expect(names).toEqual(['tx1', 'tx2']);
  });

  it('SERIALIZABLE: conflicting concurrent updates cause exactly one transaction to fail', async () => {
    const seeded = await ctx.dataSource.getRepository(TestUser).save({ name: 'initial' });

    // The conflict only exists if tx1's snapshot predates tx2's commit.
    // tx1 therefore reads first, and waits to write until tx2 has
    // committed — the barrier is released outside `runInTransaction`,
    // which is where COMMIT has already been issued.
    const tx1HasRead = barrier();
    const tx2HasCommitted = barrier();

    const results = await Promise.allSettled([
      adapter.runInTransaction({ isolation: 'SERIALIZABLE' }, async (h) => {
        const user = await h.entityManager.findOneByOrFail(TestUser, { id: seeded.id });
        tx1HasRead.reach();
        await tx2HasCommitted.reached;
        user.name = 'tx1';
        await h.entityManager.save(user);
      }),
      (async () => {
        await tx1HasRead.reached;
        try {
          await adapter.runInTransaction({ isolation: 'SERIALIZABLE' }, async (h) => {
            const user = await h.entityManager.findOneByOrFail(TestUser, { id: seeded.id });
            user.name = 'tx2';
            await h.entityManager.save(user);
          });
        } finally {
          tx2HasCommitted.reach();
        }
      })(),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    expect(rejected).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);

    const reason = rejected[0] as PromiseRejectedResult;
    expect(String(reason.reason)).toMatch(/serializ|could not serialize/i);

    // Exactly one update won. Which one is left open on purpose: the
    // ordering above makes tx1 the loser under Postgres's
    // first-updater-wins rule, but the guarantee under test is that one
    // side is refused rather than that a particular side is.
    const user = await ctx.dataSource.getRepository(TestUser).findOneByOrFail({ id: seeded.id });
    expect(['tx1', 'tx2']).toContain(user.name);
  });

  it('Postgres: nested savepoints at multiple levels commit/rollback independently', async () => {
    await adapter.runInTransaction({}, async (parent) => {
      await parent.entityManager.save(TestUser, { name: 'level-0' });

      await adapter.runInSavepoint(parent, async () => {
        await parent.entityManager.save(TestUser, { name: 'level-1' });

        await expect(
          adapter.runInSavepoint(parent, async () => {
            await parent.entityManager.save(TestUser, { name: 'level-2' });
            throw new Error('inner rollback');
          }),
        ).rejects.toThrow('inner rollback');

        // Within outer tx, level-0 and level-1 are still there; level-2 gone.
        const inTxCount = await parent.entityManager.getRepository(TestUser).count();
        expect(inTxCount).toBe(2);
      });
    });

    const names = (await ctx.dataSource.getRepository(TestUser).find()).map((u) => u.name).sort();
    expect(names).toEqual(['level-0', 'level-1']);
  });

  it('long-running transaction does not time out when no timeout is set', async () => {
    const SLEEP_MS = 2000;
    const startedAt = Date.now();

    await adapter.runInTransaction({}, async (h) => {
      await sleep(SLEEP_MS);
      await h.entityManager.save(TestUser, { name: 'slow' });
    });

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(SLEEP_MS - 100);

    const users = await ctx.dataSource.getRepository(TestUser).find();
    expect(users.map((u) => u.name)).toEqual(['slow']);
  });

  describe('readOnly (DD-027)', () => {
    // The unit specs prove which statement is emitted per dialect. These
    // prove the statement does what the option claims — that a stray
    // write inside a readOnly transaction is refused by Postgres rather
    // than committed.

    it('refuses a write with a read-only-transaction error', async () => {
      await expect(
        adapter.runInTransaction({ readOnly: true }, async (h) => {
          await h.entityManager.save(TestUser, { name: 'should-not-persist' });
        }),
      ).rejects.toThrow(/read-only transaction/i);

      expect(await ctx.dataSource.getRepository(TestUser).count()).toBe(0);
    });

    it('still allows reads', async () => {
      await ctx.dataSource.getRepository(TestUser).save({ name: 'existing' });

      const names = await adapter.runInTransaction({ readOnly: true }, async (h) =>
        (await h.entityManager.getRepository(TestUser).find()).map((u) => u.name),
      );

      expect(names).toEqual(['existing']);
    });

    it('does not leak read-only into the next transaction on the same pool', async () => {
      // `SET TRANSACTION` is scoped to the transaction, but the pooled
      // connection is reused — a leak here would turn one readOnly query
      // handler into a silently read-only application.
      await expect(
        adapter.runInTransaction({ readOnly: true }, async () => 'read-only done'),
      ).resolves.toBe('read-only done');

      await adapter.runInTransaction({}, async (h) => {
        await h.entityManager.save(TestUser, { name: 'writable-after' });
      });

      const names = (await ctx.dataSource.getRepository(TestUser).find()).map((u) => u.name);
      expect(names).toEqual(['writable-after']);
    });

    it('combines with an isolation level', async () => {
      const names = await adapter.runInTransaction(
        { readOnly: true, isolation: 'REPEATABLE_READ' },
        async (h) => (await h.entityManager.getRepository(TestUser).find()).map((u) => u.name),
      );

      expect(names).toEqual([]);
    });

    it('applies to a nested savepoint as well', async () => {
      // NESTED runs inside the same transaction, so the read-only access
      // mode is inherited — a write there must fail too.
      await expect(
        adapter.runInTransaction({ readOnly: true }, async (parent) => {
          await adapter.runInSavepoint(parent, async () => {
            await parent.entityManager.save(TestUser, { name: 'nested-write' });
          });
        }),
      ).rejects.toThrow(/read-only transaction/i);

      expect(await ctx.dataSource.getRepository(TestUser).count()).toBe(0);
    });
  });
});
