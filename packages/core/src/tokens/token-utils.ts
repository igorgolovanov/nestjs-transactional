import { DEFAULT_DATA_SOURCE_NAME } from './constants';

/**
 * Token utilities derive deterministic DI token strings from a
 * dataSource name. They are the foundation of the multi-adapter
 * architecture (ADR-018) — every package binds providers under
 * `getXxxToken(dataSource)` and every consumer injects via the same
 * function so the strings line up exactly.
 *
 * Format is `${dataSource}${Component}` (camelCase concat). The
 * default dataSource is {@link DEFAULT_DATA_SOURCE_NAME} (`'default'`)
 * — calling `getTransactionManagerToken()` yields
 * `'defaultTransactionManager'`. A non-default name like `'billing'`
 * yields `'billingTransactionManager'`.
 *
 * Empty-string `dataSource` produces a bare component string
 * (`getTransactionManagerToken('')` → `'TransactionManager'`). That
 * collides with the class-token shape NestJS uses for
 * constructor-style injection (`@Inject(TransactionManager)`), so
 * empty strings should be treated as a programming error at the call
 * site. The default argument exists specifically to prevent users
 * from hitting this case accidentally.
 */

/**
 * DI token for the per-dataSource `TransactionManager`.
 *
 * @example
 * ```ts
 * @Inject(getTransactionManagerToken('billing'))
 * private readonly txManager: TransactionManager;
 * ```
 */
export function getTransactionManagerToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}TransactionManager`;
}

/**
 * DI token for the per-dataSource `TransactionContext`. Each
 * dataSource carries its own `AsyncLocalStorage` instance — see
 * DD-023 — so cross-dataSource calls do not silently enrol into a
 * sibling transaction.
 */
export function getTransactionContextToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}TransactionContext`;
}

/**
 * DI token for the per-dataSource `TransactionAdapter` instance —
 * the concrete adapter (TypeORM, Prisma, ...) bound to the named
 * dataSource. See DD-021.
 */
export function getTransactionalAdapterToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}TransactionalAdapter`;
}

/**
 * DI token for the global `TransactionContextRegistry` — a
 * process-wide singleton that maps dataSource names to their
 * `TransactionContext` instances. Not parameterised by dataSource:
 * exactly one registry per process serves all adapters.
 */
export function getTransactionContextRegistryToken(): string {
  return 'TransactionContextRegistry';
}
