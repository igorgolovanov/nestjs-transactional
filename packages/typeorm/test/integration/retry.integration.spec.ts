import { AdapterRegistry, TransactionManager } from '@nestjs-transactional/core';
import type { EntityManager } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../../src/adapter/typeorm.adapter.js';
import { getCurrentEntityManager } from '../../src/helpers/get-entity-manager.js';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers.js';
import { TestUser } from '../shared/test-user.entity.js';

/**
 * `@Transactional({ retry })` against a real serialization failure
 * (DD-032). Two SERIALIZABLE transactions read the same rows and each
 * writes a row the other's read would have seen: a write skew, which
 * PostgreSQL resolves by failing one of them with SQLSTATE 40001.
 */
describe('transaction retry on PostgreSQL (testcontainers)', () => {
  let ctx: PostgresTestContext;
  let manager: TransactionManager;

  beforeAll(async () => {
    ctx = await startPostgresContainer({ entities: [TestUser], synchronize: true });
    const registry = new AdapterRegistry();
    registry.register({
      adapterName: 'typeorm',
      instanceName: 'default',
      adapter: new TypeOrmTransactionAdapter(ctx.dataSource, 'default'),
    });
    manager = new TransactionManager(registry);
  });

  afterAll(async () => {
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    await ctx.dataSource.getRepository(TestUser).clear();
  });

  /**
   * Both transactions read before either writes, on their first attempt:
   * the barrier opens once both have read. A retried attempt finds the
   * barrier open and runs straight through.
   */
  function writeSkew(): {
    run: (name: string) => Promise<void>;
    attempts: () => number;
  } {
    let attempts = 0;
    let arrived = 0;
    let open!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      attempts: () => attempts,
      run: async (name: string) => {
        attempts += 1;
        const em: EntityManager = getCurrentEntityManager();
        const seen = await em.count(TestUser);
        arrived += 1;
        if (arrived === 2) {
          open();
        }
        await bothRead;
        await em.save(TestUser, { name: `${name}-saw-${seen}` });
      },
    };
  }

  it('without retry, one of two conflicting SERIALIZABLE transactions fails with 40001', async () => {
    const skew = writeSkew();

    const results = await Promise.allSettled([
      manager.run({ isolation: 'SERIALIZABLE' }, () => skew.run('a')),
      manager.run({ isolation: 'SERIALIZABLE' }, () => skew.run('b')),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: '40001' });
    expect(await ctx.dataSource.getRepository(TestUser).count()).toBe(1);
  });

  it('with retry, the failed one runs again and both commit, the second seeing the first', async () => {
    const skew = writeSkew();
    const options = {
      isolation: 'SERIALIZABLE',
      retry: { maxAttempts: 3, delay: 0 },
    } as const;

    await Promise.all([
      manager.run(options, () => skew.run('a')),
      manager.run(options, () => skew.run('b')),
    ]);

    const names = (await ctx.dataSource.getRepository(TestUser).find()).map((u) => u.name).sort();
    expect(names).toHaveLength(2);
    expect(names.some((n) => n.endsWith('-saw-0'))).toBe(true);
    expect(names.some((n) => n.endsWith('-saw-1'))).toBe(true);
    expect(skew.attempts()).toBe(3);
  });
});
