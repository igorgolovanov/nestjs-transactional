import { randomUUID } from 'node:crypto';

import {
  IllegalTransactionStateError,
  type IsolationLevel,
  type TransactionAdapter,
  type TransactionOptions,
} from '@nestjs-transactional/core';
import type { DataSource, EntityManager } from 'typeorm';

import type { TypeOrmTransactionHandle } from '../types/typeorm-transaction-handle';

/**
 * TypeORM's `DataSource.transaction` accepts a space-separated SQL
 * isolation level string. Declared inline — `typeorm` does not export
 * the type from its main entry.
 */
type TypeOrmIsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

/**
 * TypeORM implementation of {@link TransactionAdapter}. Delegates begin /
 * commit / rollback to `DataSource.transaction` and emits raw `SAVEPOINT`
 * SQL for nested transactions through the transactional
 * {@link EntityManager}.
 *
 * Only `isolation` from {@link TransactionOptions} is forwarded today.
 * `readOnly` and `timeout` are accepted for forward compatibility but do
 * not yet map to per-dialect statements.
 *
 * `PropagationMode.NESTED` needs savepoints, so `runInSavepoint` first
 * checks the driver's own capability flag and rejects with
 * `IllegalTransactionStateError` on drivers that cannot do them (SQL
 * Server, SAP HANA, MongoDB, Spanner, Cordova) instead of emitting SQL
 * they will refuse.
 */
export class TypeOrmTransactionAdapter implements TransactionAdapter<TypeOrmTransactionHandle> {
  readonly name = 'typeorm';

  constructor(
    private readonly dataSource: DataSource,
    /**
     * Adapter instance name this adapter was created for (e.g.
     * `'primary'`, `'billing'`). Exposed so observability / diagnostics
     * can correlate events back to the registered instance.
     */
    readonly instanceName: string,
  ) {}

  /**
   * Public dataSource name (DD-021). For TypeORM the dataSource name
   * IS the adapter instance name — the constructor's `instanceName`
   * argument is the single user-supplied identifier.
   */
  get dataSourceName(): string {
    return this.instanceName;
  }

  async runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: TypeOrmTransactionHandle) => Promise<T>,
  ): Promise<T> {
    const isolation = mapIsolation(options.isolation);

    const runner = async (entityManager: EntityManager): Promise<T> => {
      if (options.readOnly === true) {
        await applyReadOnly(entityManager, this.dataSource.options.type);
      }

      const handle: TypeOrmTransactionHandle = {
        id: randomUUID(),
        adapterName: this.name,
        entityManager,
      };
      return fn(handle);
    };

    if (isolation !== undefined) {
      return this.dataSource.transaction(isolation, runner);
    }
    return this.dataSource.transaction(runner);
  }

  async runInSavepoint<T>(
    parent: TypeOrmTransactionHandle,
    fn: (handle: TypeOrmTransactionHandle) => Promise<T>,
  ): Promise<T> {
    this.assertSavepointsSupported();

    const savepointName = `sp_${randomUUID().replace(/-/g, '_').substring(0, 30)}`;

    await parent.entityManager.query(`SAVEPOINT ${savepointName}`);

    try {
      const result = await fn(parent);
      await parent.entityManager.query(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (err) {
      await parent.entityManager.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw err;
    }
  }

  /**
   * Fail fast when the configured driver cannot do savepoints, rather
   * than emitting `SAVEPOINT` SQL it will reject with an opaque
   * driver-level error that says nothing about `NESTED` propagation.
   *
   * TypeORM reports the capability itself — `driver.transactionSupport`
   * is `'nested'` for the savepoint-capable drivers (Postgres, MySQL,
   * Oracle, SQLite, CockroachDB, ...), `'simple'` for SQL Server and
   * SAP HANA, and `'none'` for MongoDB, Spanner and Cordova. Reading the
   * flag beats maintaining our own dialect allowlist, which would rot
   * with every driver TypeORM adds.
   *
   * Deliberately permissive when the flag is missing: a TypeORM version
   * that renames or drops it must not turn every `NESTED` call into a
   * hard failure, since absence of the signal is not evidence of absent
   * support.
   */
  private assertSavepointsSupported(): void {
    const support = (this.dataSource.driver as { transactionSupport?: string } | undefined)
      ?.transactionSupport;

    if (support !== undefined && support !== 'nested') {
      throw new IllegalTransactionStateError(
        `PropagationMode.NESTED needs savepoints, which the '${this.dataSource.options.type}' ` +
          `driver does not support (TypeORM reports transactionSupport: '${support}'). ` +
          "Use PropagationMode.REQUIRED to join the caller's transaction, or " +
          'REQUIRES_NEW for an independent one.',
      );
    }
  }
}

/**
 * Dialects where `SET TRANSACTION READ ONLY` is valid after `BEGIN`,
 * provided it precedes the transaction's first query.
 *
 * An explicit allowlist, unlike the savepoint check above: TypeORM
 * publishes a capability flag for nested transactions
 * (`driver.transactionSupport`) but none for transaction access mode, so
 * there is nothing to read. **Review this list when a driver is added.**
 *
 * MySQL and MariaDB are absent on purpose rather than by omission —
 * `SET TRANSACTION` there applies to the *next* transaction and raises
 * `ERROR 1568` inside a started one, so read-only would have to be set
 * at `START TRANSACTION` time, which TypeORM does not expose. See
 * DD-027.
 */
const READ_ONLY_DIALECTS: ReadonlySet<string> = new Set([
  'postgres',
  'cockroachdb',
  'aurora-postgres',
]);

/**
 * Ask the database to reject writes for the remainder of this
 * transaction, on the dialects that can do it.
 *
 * A silent no-op elsewhere, deliberately: `CqrsTransactionalModule`
 * defaults every query handler to `readOnly: true`, so throwing here
 * would break consumers on MySQL or SQLite over an option they never
 * set. `readOnly` is a hint in Spring too — honoured where possible
 * (DD-027).
 *
 * Must run before any user statement; Postgres rejects the statement
 * once the transaction has executed its first query.
 */
async function applyReadOnly(entityManager: EntityManager, dialect: string): Promise<void> {
  if (!READ_ONLY_DIALECTS.has(dialect)) {
    return;
  }
  await entityManager.query('SET TRANSACTION READ ONLY');
}

/**
 * Map the core's underscore-style {@link IsolationLevel} to TypeORM's
 * space-separated string. Returns `undefined` when no level is set so the
 * caller can invoke the `DataSource.transaction` overload that leaves the
 * database default in place.
 */
function mapIsolation(level: IsolationLevel | undefined): TypeOrmIsolationLevel | undefined {
  if (level === undefined) {
    return undefined;
  }
  return level.replace(/_/g, ' ') as TypeOrmIsolationLevel;
}
