/**
 * Hidden property keys used by the transparent transactional patching
 * machinery (Phase 14.20).
 *
 * `Symbol.for(...)` is used (not module-local `Symbol(...)`) so the same
 * key resolves identically across realms and across multiple copies of
 * this package that may end up in a single Node process — e.g. via pnpm
 * hoisting glitches or in monorepos with mixed dependency trees. Cross-
 * realm safety is the documented justification (matches the convention
 * used by `Symbol.for('@nestjs-transactional/wrapped')` in the core
 * package — see CLAUDE.md "Conventions finalised" §8).
 *
 * Namespaced strings prevent collision with arbitrary user code that
 * might assign symbols on TypeORM internals.
 */

/**
 * Hidden property on each managed `DataSource` instance carrying the
 * dataSource name under which it was registered (`'default'`,
 * `'billing'`, etc.). Stamped at registration time by
 * {@link markAsManaged}; read by the patched
 * `Repository.prototype.manager` getter and the patched instance-
 * level `DataSource.manager` getter to look up the active transaction
 * in `TransactionContext`.
 *
 * Mirrors typeorm-transactional's `'@transactional/data-source'`
 * string key, but kept as a `Symbol.for(...)` to avoid colliding with
 * arbitrary properties user code might set on a `DataSource`.
 */
export const TYPEORM_DATA_SOURCE_NAME = Symbol.for(
  '@nestjs-transactional/typeorm/data-source-name',
);

/**
 * Hidden property on each `Repository` instance carrying the original
 * (non-active) `EntityManager` reference. Populated when a repository
 * is constructed (TypeORM's `Repository` constructor runs
 * `this.manager = manager` — that assignment routes through the
 * patched `Repository.prototype.manager` setter and ends up here
 * instead of as an own-property).
 *
 * Used by the patched `Repository.prototype.manager` getter as the
 * fallback when no active transaction is registered for this
 * repository's dataSource. Also used to find the dataSource name —
 * the original manager carries `connection`, which carries the
 * stamped {@link TYPEORM_DATA_SOURCE_NAME}.
 */
export const TYPEORM_ENTITY_MANAGER_NAME = Symbol.for(
  '@nestjs-transactional/typeorm/entity-manager',
);

/**
 * Hidden marker on each `DataSource` instance whose per-instance
 * patches ({@link patchDataSourceInstance} in `data-source-patches.ts`)
 * have been applied. Used to make the patch operation idempotent —
 * a DataSource registered through `forRoot` more than once (e.g. on
 * test resets) does not accumulate getter/setter pairs.
 */
export const TYPEORM_DATA_SOURCE_PATCHED = Symbol.for(
  '@nestjs-transactional/typeorm/data-source-patched',
);
