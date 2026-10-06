import { randomUUID } from 'node:crypto';

import type {
  IsolationLevel,
  TransactionAdapter,
  TransactionOptions,
} from '@nestjs-transactional/core';
import { entityKind, sql } from 'drizzle-orm';

import { originalTransactionOf } from '../patching/drizzle-instance-patch.js';
import type {
  DrizzleDatabaseLike,
  DrizzleTransactionConfig,
  DrizzleTransactionHandle,
} from '../types/drizzle-transaction-handle.js';

/**
 * {@link TransactionAdapter} for a Drizzle ORM PostgreSQL database
 * (node-postgres, postgres-js, PGlite and the other PostgreSQL drivers),
 * on Drizzle 0.40+ and 1.0.
 *
 * Transactions go through Drizzle's own `transaction()`, with the
 * isolation level and the read-only access mode passed as its config.
 * Savepoints are plain SQL on the parent transaction, so they behave the
 * same on every driver. `nativeTransaction` is Drizzle's `tx`, which
 * `@nestjs/store-kit`'s `fromDrizzle()` executor takes as the
 * transaction of `@nestjs/outbox` and `@nestjs/workflows`.
 *
 * The adapter always opens a transaction with the method the database
 * had before {@link TransactionalDrizzleModule} patched it: through the
 * patched one, a REQUIRES_NEW inside a transaction would become a
 * savepoint of it.
 */
export class DrizzleTransactionAdapter implements TransactionAdapter<DrizzleTransactionHandle> {
  readonly name = 'drizzle';

  readonly dialect: string;

  constructor(
    private readonly db: DrizzleDatabaseLike,
    readonly dataSourceName: string,
  ) {
    this.dialect = dialectOf(db);
  }

  isRetryableError(error: unknown): boolean {
    return isRetryableDriverError(error, 0);
  }

  nativeTransaction(handle: DrizzleTransactionHandle): DrizzleDatabaseLike {
    return handle.tx;
  }

  runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: DrizzleTransactionHandle) => Promise<T>,
  ): Promise<T> {
    const config: DrizzleTransactionConfig = {
      ...(options.isolation !== undefined && { isolationLevel: mapIsolation(options.isolation) }),
      ...(options.readOnly === true && { accessMode: 'read only' }),
    };
    const work = (tx: DrizzleDatabaseLike): Promise<T> =>
      fn({ id: randomUUID(), adapterName: this.name, tx });
    const transactionConfig = Object.keys(config).length > 0 ? config : undefined;
    const original = originalTransactionOf(this.db);
    return original !== undefined
      ? (original.call(this.db, work, transactionConfig) as Promise<T>)
      : this.db.transaction(work, transactionConfig);
  }

  async runInSavepoint<T>(
    parent: DrizzleTransactionHandle,
    fn: (handle: DrizzleTransactionHandle) => Promise<T>,
  ): Promise<T> {
    const savepoint = `sp_${randomUUID().replace(/-/g, '_').substring(0, 30)}`;

    await parent.tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
    try {
      const result = await fn(parent);
      await parent.tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      return result;
    } catch (err) {
      await parent.tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
      throw err;
    }
  }
}

/** `'postgres'` for a Drizzle PostgreSQL database; anything else is refused. */
function dialectOf(db: unknown): string {
  const kinds: string[] = [];
  if (typeof db === 'object' && db !== null) {
    for (
      let type: unknown = db.constructor;
      typeof type === 'function';
      type = Object.getPrototypeOf(type)
    ) {
      const kind = (type as unknown as Record<symbol, unknown>)[entityKind];
      if (typeof kind === 'string') {
        kinds.push(kind);
      }
    }
  }
  if (kinds.some((kind) => /^Pg\w*Database$/.test(kind))) {
    return 'postgres';
  }
  throw new TypeError(
    'DrizzleTransactionAdapter takes a Drizzle PostgreSQL database (what drizzle() of ' +
      `drizzle-orm/node-postgres, /postgres-js, /pglite... returns), got ${
        kinds.length > 0 ? `a ${kinds[0]}` : typeof db
      }. MySQL and SQLite are not supported yet.`,
  );
}

function mapIsolation(
  level: IsolationLevel,
): NonNullable<DrizzleTransactionConfig['isolationLevel']> {
  return level.replace(/_/g, ' ').toLowerCase() as NonNullable<
    DrizzleTransactionConfig['isolationLevel']
  >;
}

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

/**
 * A serialization failure or a deadlock, found in `code` or down the
 * `cause` chain: Drizzle wraps a driver's error in `DrizzleQueryError`
 * with the original as `cause`.
 */
function isRetryableDriverError(error: unknown, depth: number): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) {
    return false;
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)) {
    return true;
  }
  return isRetryableDriverError(cause, depth + 1);
}
