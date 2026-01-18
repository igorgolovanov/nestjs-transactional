import type { ExtendedTransactionOptions } from '../types/transaction-options';

/**
 * Context passed to {@link TransactionObserver.onTransactionStart}. Built
 * once by {@link TransactionManager} when a new transaction begins —
 * i.e. the adapter has produced a {@link TransactionHandle} and the entry
 * has been registered on the active {@link TransactionContextStore}.
 */
export interface TransactionStartContext {
  /** Unique identifier of the transaction (from the adapter's handle). */
  readonly transactionId: string;

  /** Adapter type name, e.g. `'typeorm'`. */
  readonly adapterName: string;

  /** Adapter instance name, e.g. `'primary'`, `'billing'`. */
  readonly adapterInstanceName: string;

  /** Correlation id of the surrounding {@link TransactionContextStore}. */
  readonly correlationId: string;

  /** Options as passed to `TransactionManager.run`. */
  readonly options: ExtendedTransactionOptions;
}

/**
 * Context passed to {@link TransactionObserver.onTransactionCommit}.
 * Emitted after the adapter has committed; immediately before the
 * `afterCommitHooks` run.
 */
export interface TransactionCommitContext extends TransactionStartContext {
  /** Elapsed wall-clock time between transaction start and commit, in ms. */
  readonly durationMs: number;

  /** Number of `afterCommit` hooks registered on this transaction. */
  readonly commitCount: number;
}

/**
 * Context passed to {@link TransactionObserver.onTransactionRollback}.
 * Emitted after the adapter has rolled back; immediately before the
 * `afterRollbackHooks` run.
 */
export interface TransactionRollbackContext extends TransactionStartContext {
  /** Elapsed wall-clock time between transaction start and rollback, in ms. */
  readonly durationMs: number;

  /** The error that caused the rollback — propagated to the caller afterwards. */
  readonly error: unknown;

  /** Number of `afterRollback` hooks registered on this transaction. */
  readonly rollbackCount: number;
}

/**
 * Observer interface for monitoring transaction lifecycle. All methods are
 * optional so an observer can subscribe only to the events it cares about
 * (e.g. a metrics exporter typically wires only `onTransactionCommit` /
 * `onTransactionRollback`).
 *
 * Observer implementations **must not** depend on any side effect of the
 * transactional database state, and **must not** throw to influence the
 * outcome — {@link TransactionManager} catches observer errors and logs
 * them via its NestJS Logger, continuing with the remaining observers.
 * This is a monitoring hook, not a control-flow hook — use the
 * `registerAfterCommit` / `registerAfterRollback` APIs on the manager if
 * you need to react to the transaction outcome within the same unit of
 * work.
 */
export interface TransactionObserver {
  onTransactionStart?(ctx: TransactionStartContext): void;
  onTransactionCommit?(ctx: TransactionCommitContext): void;
  onTransactionRollback?(ctx: TransactionRollbackContext): void;
}

/**
 * DI token under which {@link TransactionObserver} instances are
 * registered. Wired automatically by
 * `TransactionalModule.forRoot({ observers })`; can also be provided by
 * user code for DI-resolved observers:
 *
 * ```ts
 * providers: [
 *   MetricsObserver,
 *   { provide: TRANSACTION_OBSERVERS, useFactory: (m) => [m], inject: [MetricsObserver] },
 * ]
 * ```
 */
export const TRANSACTION_OBSERVERS = Symbol('TRANSACTION_OBSERVERS');
