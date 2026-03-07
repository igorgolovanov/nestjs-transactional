import type { TransactionHandle } from './transaction-handle';
import type { TransactionOptions } from './transaction-options';

/**
 * Port for ORM-specific transaction execution. Core defines this interface;
 * each ORM integration package (for example
 * `@nestjs-transactional/typeorm`) ships a concrete implementation.
 *
 * Adapters are deliberately minimal. The manager handles propagation,
 * rollback classification, hook execution, and observability. Adapters only
 * know how to execute a function inside a fresh transaction or a nested
 * savepoint.
 *
 * @typeParam THandle - The adapter-specific handle type. Defaults to the
 *   base {@link TransactionHandle}; concrete adapters narrow this to their
 *   own extended handle (e.g. `TypeOrmTransactionHandle`).
 */
export interface TransactionAdapter<THandle extends TransactionHandle = TransactionHandle> {
  /**
   * Adapter type identifier, e.g. `'typeorm'` or `'prisma'`. Used by the
   * registry to route transactions to the correct adapter when
   * `ExtendedTransactionOptions.adapter` is set.
   */
  readonly name: string;

  /**
   * Public dataSource name this adapter instance is bound to (DD-021).
   * The single string identifier the multi-adapter API thinks in —
   * `'default'`, `'billing'`, `'inventory'`, etc. Provided by the adapter
   * (typically through its constructor) so consumers do not need to
   * track adapter type and instance name separately.
   *
   * For backwards compatibility this is also the value used as the
   * `instanceName` slot in {@link AdapterRegistration} when the adapter
   * is auto-registered via `TransactionalModule.forRoot({ adapter })`.
   */
  readonly dataSourceName: string;

  /**
   * Execute `fn` inside a new transaction. The callback receives an opaque
   * handle whose runtime type is the adapter-specific `THandle`.
   *
   * Contract:
   * - If `fn` resolves, the adapter commits and returns the resolved value.
   * - If `fn` rejects, the adapter rolls back and rethrows the error.
   * - The adapter is responsible for transaction lifecycle only — hook
   *   firing, propagation logic, and rollback classification are the
   *   manager's job.
   *
   * @param options - Isolation, read-only flag, and timeout.
   * @param fn - Async callback to execute inside the transaction.
   * @returns The value resolved by `fn`.
   */
  runInTransaction<T>(options: TransactionOptions, fn: (handle: THandle) => Promise<T>): Promise<T>;

  /**
   * Execute `fn` inside a savepoint nested under `parent`. Used by the
   * manager to implement `PropagationMode.NESTED`.
   *
   * Contract:
   * - If `fn` resolves, the adapter releases the savepoint and returns
   *   the value.
   * - If `fn` rejects, the adapter rolls back to the savepoint and
   *   rethrows the error.
   * - The parent transaction is not affected by the inner rollback.
   *
   * Adapters that do not support savepoints should throw
   * `IllegalTransactionStateError` with a clear, actionable message.
   *
   * @param parent - Handle of the enclosing transaction.
   * @param fn - Async callback to execute inside the savepoint.
   * @returns The value resolved by `fn`.
   */
  runInSavepoint<T>(parent: THandle, fn: (handle: THandle) => Promise<T>): Promise<T>;
}
