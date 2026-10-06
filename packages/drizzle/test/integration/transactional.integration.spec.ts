import {
  AdapterRegistry,
  type ExtendedTransactionOptions,
  PropagationMode,
  TransactionManager,
} from '@nestjs-transactional/core';
import { sql } from 'drizzle-orm';

import { DrizzleTransactionAdapter } from '../../src/adapter/drizzle.adapter.js';
import {
  patchDrizzleInstance,
  resetDrizzlePatchingForTesting,
} from '../../src/patching/drizzle-instance-patch.js';
import { accounts, sqlStateOf } from '../support/pglite.js';
import {
  clearAccounts,
  type ConnectedDb,
  DRIVERS,
  type IntegrationDb,
  type PostgresContext,
  startPostgres,
} from '../support/postgres.js';

class Boom extends Error {}

/**
 * `@Transactional` semantics on a real PostgreSQL with a connection pool,
 * through each driver: what PGlite's single connection cannot show
 * (REQUIRES_NEW, isolation from other connections, serialization
 * failures between concurrent transactions).
 */
describe.each(DRIVERS)('Drizzle on PostgreSQL through %s (testcontainers)', (driver) => {
  let pgctx: PostgresContext;
  let connected: ConnectedDb;
  let db: IntegrationDb;
  let manager: TransactionManager;

  beforeAll(async () => {
    pgctx = await startPostgres();
    connected = await pgctx.connect(driver);
    db = connected.db;
    resetDrizzlePatchingForTesting();
    patchDrizzleInstance(db, 'default');
    const registry = new AdapterRegistry();
    registry.register({
      adapterName: 'drizzle',
      instanceName: 'default',
      adapter: new DrizzleTransactionAdapter(db, 'default'),
    });
    manager = new TransactionManager(registry);
  });

  afterAll(async () => {
    await connected?.close();
    await pgctx?.container.stop();
  });

  beforeEach(async () => {
    await clearAccounts(db);
  });

  const transactional = <T>(fn: () => Promise<T>, options: ExtendedTransactionOptions = {}) =>
    manager.run(options, fn);
  const open = (id: string): Promise<unknown> => db.insert(accounts).values({ id, balance: 0 });

  it('keeps uncommitted writes from other connections, and commits them together', async () => {
    await transactional(async () => {
      await open('a');
      await open('b');
      expect(await pgctx.committedIds()).toEqual([]);
    });

    expect(await pgctx.committedIds()).toEqual(['a', 'b']);
  });

  it('rolls every write of the db back with the transaction', async () => {
    await expect(
      transactional(async () => {
        await open('a');
        await db.execute(sql`INSERT INTO accounts (id, balance) VALUES ('b', 0)`);
        throw new Boom('roll back');
      }),
    ).rejects.toBeInstanceOf(Boom);

    expect(await pgctx.committedIds()).toEqual([]);
  });

  it('commits a REQUIRES_NEW transaction on its own while the outer one rolls back', async () => {
    await expect(
      transactional(async () => {
        await open('outer');
        await transactional(() => open('independent'), {
          propagation: PropagationMode.REQUIRES_NEW,
        });
        expect(await pgctx.committedIds()).toEqual(['independent']);
        throw new Boom('outer fails');
      }),
    ).rejects.toBeInstanceOf(Boom);

    expect(await pgctx.committedIds()).toEqual(['independent']);
  });

  it('rolls a NESTED savepoint back while the outer transaction commits', async () => {
    await transactional(async () => {
      await open('outer');
      await expect(
        transactional(
          async () => {
            await open('nested');
            throw new Boom('nested fails');
          },
          { propagation: PropagationMode.NESTED },
        ),
      ).rejects.toBeInstanceOf(Boom);
      await open('after');
    });

    expect(await pgctx.committedIds()).toEqual(['after', 'outer']);
  });

  it('refuses writes in a read-only transaction', async () => {
    const error = await transactional(() => open('a'), { readOnly: true }).catch((e: unknown) => e);
    expect(sqlStateOf(error)).toBe('25006');

    expect(await pgctx.committedIds()).toEqual([]);
  });

  describe('retry', () => {
    /**
     * Both transactions read before either writes, on their first
     * attempt: a write skew, which PostgreSQL resolves under
     * SERIALIZABLE by failing one with SQLSTATE 40001. A retried attempt
     * finds the barrier open and runs straight through.
     */
    function writeSkew(): { run: (name: string) => Promise<void>; attempts: () => number } {
      let attempts = 0;
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        attempts: () => attempts,
        run: async (name: string) => {
          attempts += 1;
          const seen = await db.$count(accounts);
          arrived += 1;
          if (arrived === 2) {
            release();
          }
          await bothRead;
          await open(`${name}-saw-${seen}`);
        },
      };
    }

    it('without retry, one of two conflicting SERIALIZABLE transactions fails', async () => {
      const skew = writeSkew();

      const results = await Promise.allSettled([
        transactional(() => skew.run('a'), { isolation: 'SERIALIZABLE' }),
        transactional(() => skew.run('b'), { isolation: 'SERIALIZABLE' }),
      ]);

      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(new DrizzleTransactionAdapter(db, 'x').isRetryableError(rejected[0]?.reason)).toBe(
        true,
      );
      expect(await pgctx.committedIds()).toHaveLength(1);
    });

    it('with retry, the failed one runs again and both commit', async () => {
      const skew = writeSkew();
      const options = { isolation: 'SERIALIZABLE', retry: { maxAttempts: 3, delay: 0 } } as const;

      await Promise.all([
        transactional(() => skew.run('a'), options),
        transactional(() => skew.run('b'), options),
      ]);

      const ids = await pgctx.committedIds();
      expect(ids).toHaveLength(2);
      expect(ids.some((id) => id.endsWith('-saw-0'))).toBe(true);
      expect(ids.some((id) => id.endsWith('-saw-1'))).toBe(true);
      expect(skew.attempts()).toBe(3);
    });
  });
});
