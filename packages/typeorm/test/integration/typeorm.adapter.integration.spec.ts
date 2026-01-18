import { TypeOrmTransactionAdapter } from '../../src/adapter/typeorm.adapter';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';
import { TestUser } from '../shared/test-user.entity';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

    await Promise.all([
      adapter.runInTransaction({ isolation: 'REPEATABLE_READ' }, async (h) => {
        await h.entityManager.save(TestUser, { name: 'tx1' });
        await sleep(100);
        // With REPEATABLE READ snapshot isolation, tx1 sees only its own write.
        tx1InnerCount = await h.entityManager.getRepository(TestUser).count();
      }),
      adapter.runInTransaction({ isolation: 'REPEATABLE_READ' }, async (h) => {
        await sleep(50);
        await h.entityManager.save(TestUser, { name: 'tx2' });
        tx2InnerCount = await h.entityManager.getRepository(TestUser).count();
      }),
    ]);

    expect(tx1InnerCount).toBe(1);
    expect(tx2InnerCount).toBe(1);

    const names = (await ctx.dataSource.getRepository(TestUser).find()).map((u) => u.name).sort();
    expect(names).toEqual(['tx1', 'tx2']);
  });

  it('SERIALIZABLE: conflicting concurrent updates cause exactly one transaction to fail', async () => {
    const seeded = await ctx.dataSource.getRepository(TestUser).save({ name: 'initial' });

    const results = await Promise.allSettled([
      adapter.runInTransaction({ isolation: 'SERIALIZABLE' }, async (h) => {
        const user = await h.entityManager.findOneByOrFail(TestUser, { id: seeded.id });
        await sleep(100);
        user.name = 'tx1';
        await h.entityManager.save(user);
      }),
      adapter.runInTransaction({ isolation: 'SERIALIZABLE' }, async (h) => {
        await sleep(50);
        const user = await h.entityManager.findOneByOrFail(TestUser, { id: seeded.id });
        user.name = 'tx2';
        await h.entityManager.save(user);
      }),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    expect(rejected).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);

    const reason = rejected[0] as PromiseRejectedResult;
    expect(String(reason.reason)).toMatch(/serializ|could not serialize/i);

    // Exactly one update won.
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
});
