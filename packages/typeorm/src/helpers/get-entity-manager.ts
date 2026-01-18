import { IllegalTransactionStateError, TransactionContext } from '@nestjs-transactional/core';
import type { DataSource, EntityManager } from 'typeorm';

import type { TypeOrmTransactionHandle } from '../types/typeorm-transaction-handle';

/**
 * Compose the `TransactionContext` lookup key for the TypeORM adapter.
 * Must match the `${adapterName}:${instanceName}` format that
 * `TransactionManager` in core writes under. Keeping it private forces
 * all helper call-sites to go through the same builder.
 */
function typeOrmContextKey(adapterInstance: string): string {
  return `typeorm:${adapterInstance}`;
}

/**
 * Return the TypeORM {@link EntityManager} bound to the currently active
 * transaction on the given adapter instance. Repositories and services
 * call this to stay inside the surrounding `@Transactional` scope without
 * having to thread the EntityManager through their arguments.
 *
 * Resolution order:
 * 1. If a transaction is active on `typeorm:${adapterInstance}`, return
 *    its EntityManager — every write goes through the transaction.
 * 2. Otherwise, if `fallback` is provided, return `fallback.manager` —
 *    writes execute autocommit.
 * 3. Otherwise throw {@link IllegalTransactionStateError}. Passing no
 *    fallback is a deliberate assertion that the caller MUST be inside
 *    a transaction.
 *
 * @param adapterInstance - Adapter instance name. Defaults to `'default'`.
 * @param fallback - DataSource used when no transaction is active.
 */
export function getCurrentEntityManager(
  adapterInstance = 'default',
  fallback?: DataSource,
): EntityManager {
  const active = TransactionContext.getActiveTransaction(typeOrmContextKey(adapterInstance));

  if (active !== undefined) {
    return (active.handle as TypeOrmTransactionHandle).entityManager;
  }

  if (fallback !== undefined) {
    return fallback.manager;
  }

  throw new IllegalTransactionStateError(
    `No active transaction for 'typeorm:${adapterInstance}' and no fallback DataSource ` +
      `provided. Either wrap the call with @Transactional() or pass a DataSource as fallback.`,
  );
}

/**
 * Predicate: is there an active TypeORM transaction on this adapter
 * instance? Useful to guard side effects that must only fire inside a
 * transaction.
 */
export function isInTransaction(adapterInstance = 'default'): boolean {
  return TransactionContext.getActiveTransaction(typeOrmContextKey(adapterInstance)) !== undefined;
}
