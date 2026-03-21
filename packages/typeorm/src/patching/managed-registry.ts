/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
// The patching machinery stamps and reads hidden symbol-keyed
// properties on TypeORM internals (`DataSource`, `EntityManager`,
// `Repository`). These properties live outside TypeORM's public
// types by design, so unsafe-access lint rules fire on every
// access. File-level disable keeps the patch code readable; the
// runtime contract is documented in JSDoc above each patch.

import { TransactionContext } from '@nestjs-transactional/core';
import type { DataSource, EntityManager } from 'typeorm';

import type { TypeOrmTransactionHandle } from '../types/typeorm-transaction-handle';

import { TYPEORM_DATA_SOURCE_NAME } from './symbols';

/**
 * Process-wide set of `DataSource` instances we have registered as
 * "managed" via {@link markAsManaged}. The patched
 * `Repository.prototype.manager` getter consults this set to decide
 * whether to dispatch transactionally or pass through unchanged —
 * non-managed DataSources (e.g. those a user created manually outside
 * `TypeOrmTransactionalModule`) MUST behave exactly as TypeORM does
 * normally.
 *
 * `WeakSet` over `Set`: a managed DataSource that is destroyed and
 * eligible for GC should not be retained by us.
 *
 * `let` not `const` so {@link resetManagedRegistry} can swap in a
 * fresh empty `WeakSet` — the standard `WeakSet` API offers no
 * `.clear()` method, and recreating the reference is the cleanest
 * way to drop every managed entry at once for test isolation.
 */
let managedDataSources = new WeakSet<DataSource>();

/**
 * Register `dataSource` as a "managed" DataSource under the supplied
 * `name`. Stamps the name as a hidden property on the DataSource
 * (under {@link TYPEORM_DATA_SOURCE_NAME}) and adds the instance to
 * the {@link managedDataSources} WeakSet.
 *
 * Both pieces of state are read by the patched `Repository.prototype.manager`
 * getter and by the per-instance `DataSource.manager` getter — the
 * WeakSet membership decides whether the dispatch is transactional at
 * all, and the stamped name resolves the
 * `TransactionContext.getActiveTransactionByDataSource(name)` lookup.
 *
 * Idempotent — calling twice with the same `(dataSource, name)` pair
 * is a no-op. Calling twice with different names overwrites the
 * stamped name silently; in practice every callsite is
 * `TypeOrmTransactionalModule.forRoot`, which dedups upstream via its
 * own static-Map mechanism, so this collision should never occur in
 * production.
 */
export function markAsManaged(dataSource: DataSource, name: string): void {
  managedDataSources.add(dataSource);
  // Stamp the name as a hidden property. Cast to any to avoid a
  // TypeORM type-shape change: we intentionally augment the runtime
  // object without touching its public surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dataSource as any)[TYPEORM_DATA_SOURCE_NAME] = name;
}

/** Predicate: is `dataSource` registered as managed? */
export function isManaged(dataSource: DataSource): boolean {
  return managedDataSources.has(dataSource);
}

/**
 * Read the dataSource name stamped on `dataSource` by
 * {@link markAsManaged}. Returns `undefined` if the DataSource has
 * not been registered as managed.
 */
export function getManagedDataSourceName(dataSource: DataSource): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (dataSource as any)[TYPEORM_DATA_SOURCE_NAME];
}

/**
 * Resolve the active transactional `EntityManager` for the given
 * dataSource name from {@link TransactionContext}. Returns
 * `undefined` when there is no active transaction on the current
 * async chain for this dataSource — the patched getters use that
 * to fall back to the original manager (autocommit semantics).
 *
 * Centralised here so every patch site goes through the same
 * resolution rule — one place to evolve when the underlying lookup
 * changes.
 */
export function getActiveEntityManager(dataSourceName: string): EntityManager | undefined {
  const activeTx = TransactionContext.getActiveTransactionByDataSource(dataSourceName);
  if (activeTx === undefined) {
    return undefined;
  }
  return (activeTx.handle as TypeOrmTransactionHandle).entityManager;
}

/**
 * Test-only — drop every managed DataSource registration so a fresh
 * test starts from a clean slate. Recreates the `WeakSet` (no
 * `.clear()` API on `WeakSet`).
 *
 * NOTE: this does NOT undo the {@link TYPEORM_DATA_SOURCE_NAME} stamp
 * on individual DataSource instances, nor does it revert the
 * per-instance patches applied by {@link patchDataSourceInstance}.
 * Tests that build a fresh `DataSource` per case are unaffected
 * (the stale stamp is never observed). Tests that reuse a
 * `DataSource` across `TransactionalModule.resetForTesting()` calls
 * are not supported — destroy and recreate the DataSource between
 * cases instead.
 *
 * @internal
 */
export function resetManagedRegistry(): void {
  managedDataSources = new WeakSet<DataSource>();
}
