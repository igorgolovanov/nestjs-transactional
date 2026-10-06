import {
  AdapterRegistry,
  type ExtendedTransactionOptions,
  PropagationMode,
  TransactionManager,
} from '@nestjs-transactional/core';
import { eq, sql } from 'drizzle-orm';

import { accountIds, accounts, createTestDb, type TestDb } from '../../test/support/pglite.js';
import { DrizzleTransactionAdapter } from '../adapter/drizzle.adapter.js';

import {
  managedDataSourceOf,
  originalTransactionOf,
  patchDrizzleInstance,
  resetDrizzlePatchingForTesting,
} from './drizzle-instance-patch.js';

class Boom extends Error {}

describe('patchDrizzleInstance', () => {
  let db: TestDb;
  let manager: TransactionManager;

  beforeEach(async () => {
    resetDrizzlePatchingForTesting();
    db = await createTestDb();
    patchDrizzleInstance(db, 'default');
    const registry = new AdapterRegistry();
    registry.register({
      adapterName: 'drizzle',
      instanceName: 'default',
      adapter: new DrizzleTransactionAdapter(db, 'default'),
    });
    manager = new TransactionManager(registry);
  });

  afterEach(async () => {
    await db.$client.close();
  });

  const transactional = <T>(fn: () => Promise<T>, options: ExtendedTransactionOptions = {}) =>
    manager.run(options, fn);

  it('routes the query builders of the db into the transaction', async () => {
    await expect(
      transactional(async () => {
        await db.insert(accounts).values([
          { id: 'a', balance: 1 },
          { id: 'b', balance: 2 },
        ]);
        await db.update(accounts).set({ balance: 10 }).where(eq(accounts.id, 'a'));
        await db.delete(accounts).where(eq(accounts.id, 'b'));
        expect(await db.select().from(accounts)).toEqual([{ id: 'a', balance: 10 }]);
        throw new Boom('roll it all back');
      }),
    ).rejects.toBeInstanceOf(Boom);

    expect(await accountIds(db)).toEqual([]);
  });

  it('routes execute, $count, $with and the relational queries', async () => {
    await expect(
      transactional(async () => {
        await db.execute(sql`INSERT INTO accounts (id, balance) VALUES ('raw', 5)`);
        expect(await db.$count(accounts)).toBe(1);
        expect(await db.query.accounts.findMany()).toEqual([{ id: 'raw', balance: 5 }]);
        const rich = db.$with('rich').as(db.select().from(accounts));
        expect(await db.with(rich).select().from(rich)).toHaveLength(1);
        throw new Boom('roll back');
      }),
    ).rejects.toBeInstanceOf(Boom);

    expect(await accountIds(db)).toEqual([]);
  });

  it('commits what the db wrote once the transaction commits', async () => {
    await transactional(async () => {
      await db.insert(accounts).values({ id: 'kept', balance: 0 });
    });

    expect(await accountIds(db)).toEqual(['kept']);
  });

  it('leaves the db as it was outside a transaction', async () => {
    await db.insert(accounts).values({ id: 'plain', balance: 0 });

    expect(await db.query.accounts.findFirst()).toEqual({ id: 'plain', balance: 0 });
  });

  it('turns db.transaction() inside a transaction into a savepoint', async () => {
    await transactional(async () => {
      await db.insert(accounts).values({ id: 'outer', balance: 0 });
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(accounts).values({ id: 'inner', balance: 0 });
          throw new Boom('inner only');
        }),
      ).rejects.toBeInstanceOf(Boom);
    });

    expect(await accountIds(db)).toEqual(['outer']);
  });

  it('routes NESTED through a savepoint the db joins', async () => {
    await transactional(async () => {
      await db.insert(accounts).values({ id: 'outer', balance: 0 });
      await expect(
        transactional(
          async () => {
            await db.insert(accounts).values({ id: 'nested', balance: 0 });
            throw new Boom('nested only');
          },
          { propagation: PropagationMode.NESTED },
        ),
      ).rejects.toBeInstanceOf(Boom);
    });

    expect(await accountIds(db)).toEqual(['outer']);
  });

  it('keeps the original transaction method for the adapter', () => {
    const original = originalTransactionOf(db);

    expect(original).toBe(Object.getPrototypeOf(Object.getPrototypeOf(db)).transaction);
    expect(db.transaction).not.toBe(original);
  });

  it('is idempotent for the same dataSource name', () => {
    const patched = db.insert;

    patchDrizzleInstance(db, 'default');

    expect(db.insert).toBe(patched);
    expect(managedDataSourceOf(db)).toBe('default');
  });

  it('refuses the same db under a second dataSource name', () => {
    expect(() => patchDrizzleInstance(db, 'billing')).toThrow(
      /already registered as dataSource 'default'/,
    );
  });

  it('stops routing once the patching is reset, leaving the wrappers inert', async () => {
    resetDrizzlePatchingForTesting();

    expect(managedDataSourceOf(db)).toBeUndefined();
    // PGlite has one connection, so an unrouted call inside a transaction
    // would wait for it forever; outside one, the wrapper just delegates.
    await db.insert(accounts).values({ id: 'unmanaged', balance: 0 });
    expect(await accountIds(db)).toEqual(['unmanaged']);
  });
});
