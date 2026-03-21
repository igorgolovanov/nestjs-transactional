/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
// The patching machinery overrides instance-level methods on
// TypeORM `DataSource` objects (`manager` getter/setter,
// `query`, `createQueryBuilder`) via runtime property descriptors.
// The inputs and outputs are intentionally typed as `any` because
// TypeORM's generic signatures don't survive the wrap; the runtime
// contract is documented in JSDoc above each patch. File-level
// disable keeps the patch code readable.

import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { getActiveEntityManager, getManagedDataSourceName } from './managed-registry';
import { TYPEORM_DATA_SOURCE_PATCHED } from './symbols';

/**
 * Apply per-instance patches to a single `DataSource` at the time
 * it's registered as managed. Three patches go on the instance
 * itself (NOT the prototype) because TypeORM sets the affected
 * properties as own-properties in the `DataSource` constructor —
 * patching `DataSource.prototype` would be shadowed by every
 * instance.
 *
 * Patches applied:
 *
 * 1. `dataSource.manager` — replaced with a getter/setter pair.
 *    The getter returns the active transactional `EntityManager`
 *    when one is registered for this dataSource's name; otherwise
 *    falls back to the original (closure-captured) manager. The
 *    setter is preserved so any TypeORM-internal reassignment
 *    updates the captured original.
 *
 * 2. `dataSource.query(sql, params, queryRunner?)` — wrapped to
 *    default the `queryRunner` argument from the active
 *    transactional EntityManager when one is available. Without
 *    this wrap, raw SQL via `dataSource.query(...)` would always
 *    run on the autocommit pool, even inside a `@Transactional()`.
 *
 * 3. `dataSource.createQueryBuilder(entity?, alias?, queryRunner?)`
 *    — wrapped likewise, so query builders created via the
 *    DataSource (rather than via a Repository) also pick up the
 *    transactional QueryRunner.
 *
 * `dataSource.transaction(...)` is NOT patched — it delegates to
 * `manager.transaction(...)` internally (which already uses the
 * patched `manager` getter), and re-routing it through any of our
 * machinery would just be a no-op forward.
 *
 * **Idempotent**: a marker symbol ({@link TYPEORM_DATA_SOURCE_PATCHED})
 * is stamped on each patched DataSource so that double registration
 * (e.g. test reset followed by re-registration of the same
 * DataSource) does not stack getter/setter pairs. Calling this
 * function on an already-patched DataSource is a no-op.
 *
 * Note: the patches are applied to a specific `DataSource` instance
 * and survive on that instance until garbage collection. There is
 * no per-instance revert API; tests that need a clean slate
 * destroy the DataSource and create a fresh one (the standard
 * pattern; integration tests already do this in `afterAll`).
 */
export function patchDataSourceInstance(dataSource: DataSource): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((dataSource as any)[TYPEORM_DATA_SOURCE_PATCHED] === true) {
    return;
  }

  // (1) `manager` — getter/setter on the instance.
  let originalManager: EntityManager = dataSource.manager;
  Object.defineProperty(dataSource, 'manager', {
    configurable: true,
    get(): EntityManager {
      const dsName = getManagedDataSourceName(dataSource);
      if (dsName === undefined) {
        return originalManager;
      }
      const active = getActiveEntityManager(dsName);
      return active ?? originalManager;
    },
    set(manager: EntityManager): void {
      originalManager = manager;
    },
  });

  // (2) `query(sql, params, queryRunner?)` — pick up the active QR
  // when none is supplied. The wrapper bypasses the generic type
  // shape of `DataSource.query` via `any` casts; the runtime
  // contract is unchanged (sql first, params second, qr third).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalQuery = dataSource.query.bind(dataSource) as (...args: any[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dataSource as any).query = function patchedQuery(
    this: DataSource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ): unknown {
    if (args.length >= 3) {
      // Caller passed a queryRunner explicitly — respect it.
      return originalQuery(...args);
    }
    const activeQueryRunner = pickActiveQueryRunner(this);
    if (activeQueryRunner !== undefined) {
      return originalQuery(args[0], args[1], activeQueryRunner);
    }
    return originalQuery(...args);
  };

  // (3) `createQueryBuilder(entity?, alias?, queryRunner?)` —
  // mirror logic for QB creation.
  const originalCreateQueryBuilder = dataSource.createQueryBuilder.bind(
    dataSource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as (...args: any[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dataSource as any).createQueryBuilder = function patchedCreateQueryBuilder(
    this: DataSource,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ): unknown {
    const activeQueryRunner = pickActiveQueryRunner(this);
    if (args.length === 0) {
      return activeQueryRunner !== undefined
        ? originalCreateQueryBuilder(activeQueryRunner)
        : originalCreateQueryBuilder();
    }
    if (args.length >= 3) {
      return originalCreateQueryBuilder(...args);
    }
    if (activeQueryRunner !== undefined) {
      return originalCreateQueryBuilder(args[0], args[1], activeQueryRunner);
    }
    return originalCreateQueryBuilder(...args);
  };

  // Stamp marker so re-entry is a no-op.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dataSource as any)[TYPEORM_DATA_SOURCE_PATCHED] = true;
}

/**
 * Helper — look up the active transactional EntityManager for this
 * DataSource and return its `queryRunner` (or `undefined` if no
 * transaction is active). Centralised so the `query` and
 * `createQueryBuilder` patches share one resolution rule.
 */
function pickActiveQueryRunner(ds: DataSource): QueryRunner | undefined {
  const dsName = getManagedDataSourceName(ds);
  if (dsName === undefined) {
    return undefined;
  }
  const active = getActiveEntityManager(dsName);
  return active?.queryRunner;
}
