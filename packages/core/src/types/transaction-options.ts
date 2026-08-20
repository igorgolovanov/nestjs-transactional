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
   * Hint that the transaction will only issue reads. A hint by design,
   * matching Spring's semantics: adapters honour it where the underlying
   * database allows, and ignore it where it cannot be expressed
   * (DD-027).
   *
   * `TypeOrmTransactionAdapter` issues `SET TRANSACTION READ ONLY` on
   * Postgres-family dialects (`postgres`, `cockroachdb`,
   * `aurora-postgres`), so a write inside the transaction is refused by
   * the database. On every other dialect it is a silent no-op — notably
   * MySQL, where the access mode can only be set as
   * `START TRANSACTION READ ONLY` and TypeORM does not expose that
   * moment.
   *
   * Only applies when the adapter actually starts the transaction: a
   * `REQUIRED` call joining an existing read-write transaction cannot
   * make it read-only after the fact.
   */
  readonly readOnly?: boolean;

  /**
   * Budget for the whole transaction, in milliseconds. Omit for no
   * timeout.
   *
   * NOT IMPLEMENTED by `TypeOrmTransactionAdapter`, and deliberately not
   * approximated (DD-027). TypeORM exposes no transaction-level timeout,
   * and the nearest dialect feature — Postgres' `statement_timeout` —
   * bounds each statement rather than the transaction, so
   * `timeout: 5000` on a method issuing four queries would allow twenty
   * seconds, not five. A wrong meaning under a familiar name is worse
   * than a documented gap.
   *
   * The option stays in the surface as the extension point for adapters
   * whose driver has a real transaction budget: Prisma's `$transaction`
   * accepts exactly this.
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
