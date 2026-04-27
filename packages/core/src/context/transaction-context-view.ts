import {
  type ActiveTransaction,
  TransactionContext,
} from './transaction.context';

/**
 * Per-dataSource read-only view over {@link TransactionContext}'s active
 * transaction Map (DD-022). Bound to a single dataSource name at
 * construction; consumers ask "is there an active transaction for *my*
 * dataSource?" without typing the name twice.
 *
 * Mutations (set / remove) intentionally do NOT live on this surface —
 * they remain on `TransactionContext` and are the domain of
 * {@link TransactionManager} alone. The view is a thin lookup helper
 * to keep the per-dataSource inject-decorator surface (DD-022)
 * meaningful without duplicating the lifecycle API.
 *
 * Wired by `TransactionalModule.forRoot` under
 * `getTransactionContextToken(dataSource)`. Inject via
 * `@InjectTransactionContext(dataSource?)`.
 */
export class TransactionContextView {
  /**
   * @param dataSource - Public dataSource name this view is bound to.
   *   `'default'` for the single-adapter case.
   */
  constructor(readonly dataSource: string) {}

  /**
   * Return the active transaction for the bound dataSource, or
   * `undefined` if none is active. Equivalent to calling
   * `TransactionContext.getActiveTransactionByDataSource(this.dataSource)`.
   */
  getActiveTransaction(): ActiveTransaction | undefined {
    return TransactionContext.getActiveTransactionByDataSource(this.dataSource);
  }

  /**
   * Predicate convenience over {@link getActiveTransaction}. Useful for
   * smart-facade publishers (DD-024) that branch on whether the bound
   * dataSource is the one currently running a transaction.
   */
  hasActiveTransaction(): boolean {
    return this.getActiveTransaction() !== undefined;
  }
}
