import { entityKind, sql } from 'drizzle-orm';

import {
  accountIds,
  accounts,
  createTestDb,
  sqlStateOf,
  type TestDb,
} from '../../test/support/pglite.js';
import type { DrizzleTransactionHandle } from '../types/drizzle-transaction-handle.js';

import { DrizzleTransactionAdapter } from './drizzle.adapter.js';

class Boom extends Error {}

describe('DrizzleTransactionAdapter', () => {
  let db: TestDb;
  let adapter: DrizzleTransactionAdapter;

  beforeEach(async () => {
    db = await createTestDb();
    adapter = new DrizzleTransactionAdapter(db, 'default');
  });

  afterEach(async () => {
    await db.$client.close();
  });

  /** The handle's transaction, typed as the test schema's database. */
  const txOf = (handle: DrizzleTransactionHandle): TestDb =>
    adapter.nativeTransaction(handle) as unknown as TestDb;
  const insert = (handle: DrizzleTransactionHandle, id: string): Promise<unknown> =>
    txOf(handle).insert(accounts).values({ id, balance: 0 });

  it('names itself and the dataSource, and reports the postgres dialect', () => {
    expect(adapter.name).toBe('drizzle');
    expect(adapter.dataSourceName).toBe('default');
    expect(adapter.dialect).toBe('postgres');
  });

  it('commits when the callback resolves', async () => {
    const result = await adapter.runInTransaction({}, async (handle) => {
      await insert(handle, 'a');
      return 'done';
    });

    expect(result).toBe('done');
    expect(await accountIds(db)).toEqual(['a']);
  });

  it('rolls back and rethrows when the callback rejects', async () => {
    await expect(
      adapter.runInTransaction({}, async (handle) => {
        await insert(handle, 'a');
        throw new Boom('nope');
      }),
    ).rejects.toBeInstanceOf(Boom);

    expect(await accountIds(db)).toEqual([]);
  });

  it("hands out Drizzle's own transaction object as the native transaction", async () => {
    await adapter.runInTransaction({}, async (handle) => {
      const tx = adapter.nativeTransaction(handle) as object;
      const kind = (tx.constructor as unknown as Record<symbol, unknown>)[entityKind];
      expect(kind).toMatch(/^Pg\w*Transaction$/);
      expect(handle.adapterName).toBe('drizzle');
      expect(handle.id).toEqual(expect.any(String));
    });
  });

  it('opens the transaction at the requested isolation level', async () => {
    const level = await adapter.runInTransaction({ isolation: 'SERIALIZABLE' }, async (handle) => {
      const rows = await txOf(handle).execute<{ transaction_isolation: string }>(
        sql`SHOW transaction_isolation`,
      );
      return rows.rows[0]?.transaction_isolation;
    });

    expect(level).toBe('serializable');
  });

  it('opens a read-only transaction that refuses writes', async () => {
    const error = await adapter
      .runInTransaction({ readOnly: true }, (handle) => insert(handle, 'a'))
      .catch((e: unknown) => e);
    expect(sqlStateOf(error)).toBe('25006');

    expect(await accountIds(db)).toEqual([]);
  });

  describe('runInSavepoint', () => {
    it('keeps the work of a savepoint that resolves', async () => {
      await adapter.runInTransaction({}, async (handle) => {
        await insert(handle, 'outer');
        await adapter.runInSavepoint(handle, (inner) => insert(inner, 'inner'));
      });

      expect(await accountIds(db)).toEqual(['inner', 'outer']);
    });

    it('rolls back only the savepoint when it rejects', async () => {
      await adapter.runInTransaction({}, async (handle) => {
        await insert(handle, 'outer');
        await expect(
          adapter.runInSavepoint(handle, async (inner) => {
            await insert(inner, 'inner');
            throw new Boom('inner fails');
          }),
        ).rejects.toBeInstanceOf(Boom);
        await insert(handle, 'after');
      });

      expect(await accountIds(db)).toEqual(['after', 'outer']);
    });

    it('hands the savepoint the parent handle', async () => {
      await adapter.runInTransaction({}, async (handle) => {
        await adapter.runInSavepoint(handle, async (inner) => {
          expect(inner).toBe(handle);
        });
      });
    });
  });

  describe('isRetryableError', () => {
    it.each([
      ['a serialization failure', { code: '40001' }],
      ['a deadlock', { code: '40P01' }],
      [
        'one wrapped by DrizzleQueryError',
        Object.assign(new Error('q'), { cause: { code: '40001' } }),
      ],
      ['one wrapped twice', { cause: { cause: { code: '40P01' } } }],
    ])('retries %s', (_label, error) => {
      expect(adapter.isRetryableError(error)).toBe(true);
    });

    it.each([
      ['a unique violation', { code: '23505' }],
      ['a plain error', new Error('nope')],
      ['a string', '40001'],
      ['null', null],
      [
        'a cause chain deeper than four',
        { cause: { cause: { cause: { cause: { cause: { code: '40001' } } } } } },
      ],
    ])('does not retry %s', (_label, error) => {
      expect(adapter.isRetryableError(error)).toBe(false);
    });
  });

  it('refuses a db that is not a Drizzle PostgreSQL database', () => {
    expect(() => new DrizzleTransactionAdapter({} as never, 'default')).toThrow(
      /takes a Drizzle PostgreSQL database/,
    );
  });
});
