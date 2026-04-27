import type { Type } from '@nestjs/common';

import type { IsolationLevel } from './isolation';
import type { PropagationMode } from './propagation';

/**
 * Options passed by the core runtime down into an adapter's
 * `runInTransaction`. They describe the per-transaction runtime parameters
 * that are meaningful to the adapter itself — propagation, rollback rules,
 * and adapter selection are handled at the manager level and never reach
 * the adapter.
 */
export interface TransactionOptions {
  /**
   * SQL isolation level for the transaction. Omit to use the adapter's
   * default (typically the database default, e.g. `READ_COMMITTED` on
   * Postgres).
   */
  readonly isolation?: IsolationLevel;

  /**
   * Hint that the transaction will only issue reads. Adapters may use this
   * to route to a read replica or to issue `SET TRANSACTION READ ONLY`.
   * It is a hint, not an enforcement — writes may still be attempted and
   * may be rejected by the database.
   */
  readonly readOnly?: boolean;

  /**
   * Transaction timeout in milliseconds. If the adapter supports
   * transaction-level timeouts (e.g. `statement_timeout` on Postgres),
   * exceeding this triggers a rollback. Omit for no timeout.
   */
  readonly timeout?: number;
}

/**
 * Options accepted by `TransactionManager.run` and by the `@Transactional`
 * decorator. Extends {@link TransactionOptions} with manager-level
 * concerns: which adapter to use, propagation, and rollback classification.
 */
export interface ExtendedTransactionOptions extends TransactionOptions {
  /**
   * Name of the adapter type to use, e.g. `'typeorm'` or `'prisma'`.
   * Select explicitly when multiple adapter types are registered in the
   * same application. If omitted, the default adapter (as configured in
   * `TransactionalModule.forRoot`) is used.
   */
  readonly adapter?: string;

  /**
   * Name of the specific adapter instance to use, e.g. `'primary'` or
   * `'billing'`. Used for multi-datasource setups where the same adapter
   * type is registered against multiple DataSources. If omitted, the
   * instance registered with `isDefault: true` is used.
   *
   * Prefer {@link ExtendedTransactionOptions.dataSource} for new code —
   * it identifies the dataSource directly without needing to also know
   * the adapter type. `adapterInstance` is preserved for backwards
   * compatibility with single-adapter call sites.
   */
  readonly adapterInstance?: string;

  /**
   * Public dataSource name to target (DD-020). When set, the manager
   * resolves the adapter via {@link AdapterRegistry.getByDataSource}
   * and uses this name as the active-transaction Map key suffix —
   * cross-dataSource enrolment is structurally impossible (DD-023).
   *
   * Mutually exclusive with the `adapter` / `adapterInstance` pair —
   * if `dataSource` is set, the others are ignored. If omitted, the
   * legacy resolution path (`adapter` + `adapterInstance`, falling
   * back to registry defaults) is used. Single-adapter consumers
   * never need to set this explicitly.
   */
  readonly dataSource?: string;

  /**
   * How this transaction should relate to an already-active transaction
   * on the current async context. Defaults to {@link PropagationMode.REQUIRED}.
   */
  readonly propagation?: PropagationMode;

  /**
   * Error classes that should trigger a rollback even when the default
   * classification would not. An empty or omitted list means the default
   * policy: roll back on any thrown error.
   */
  readonly rollbackFor?: readonly Type<Error>[];

  /**
   * Error classes that should NOT trigger a rollback. When a thrown error
   * is an instance of any class in this list, the transaction is committed
   * and the error is rethrown to the caller.
   */
  readonly noRollbackFor?: readonly Type<Error>[];
}
