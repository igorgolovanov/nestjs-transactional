import { IllegalTransactionStateError, TransactionContext } from '@nestjs-transactional/core';

import type { DrizzleTransactionHandle } from '../types/drizzle-transaction-handle.js';

function contextKey(dataSource: string): string {
  return `drizzle:${dataSource}`;
}

/**
 * The `tx` of the transaction `@Transactional` opened on `dataSource`.
 *
 * The injected database already routes there, so most code never needs
 * this. It is for a database the module does not manage (one created
 * outside DI) and for code that wants the `tx` itself. Outside a
 * transaction it returns `fallback`, or throws without one.
 *
 * @typeParam TTx - The `tx` type of your schema and driver, for example
 *   `NodePgDatabase<typeof schema>`, since a `tx` has the database's API.
 */
export function getCurrentDrizzleTransaction<TTx = unknown>(
  dataSource = 'default',
  fallback?: TTx,
): TTx {
  const active = TransactionContext.getActiveTransaction(contextKey(dataSource));

  if (active !== undefined) {
    return (active.handle as DrizzleTransactionHandle).tx as TTx;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new IllegalTransactionStateError(
    `No active transaction for '${contextKey(dataSource)}' and no fallback database ` +
      'provided. Either wrap the call with @Transactional() or pass the database as fallback.',
  );
}

/** Whether a transaction `@Transactional` opened is active on `dataSource`. */
export function isInDrizzleTransaction(dataSource = 'default'): boolean {
  return TransactionContext.getActiveTransaction(contextKey(dataSource)) !== undefined;
}
