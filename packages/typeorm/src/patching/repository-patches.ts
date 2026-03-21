/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
// The patching machinery stamps and reads hidden symbol-keyed
// properties on TypeORM `Repository` instances. These properties
// live outside TypeORM's public types by design, so unsafe-access
// and unbound-method lint rules fire on every access. File-level
// disable keeps the patch code readable; the runtime contract is
// documented in the JSDoc above each patch.

import { Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';

import { getActiveEntityManager, getManagedDataSourceName, isManaged } from './managed-registry';
import { TYPEORM_ENTITY_MANAGER_NAME } from './symbols';

/**
 * Tracks whether the prototype patch has been installed on
 * `Repository.prototype`. Once installed, the patch lives for the
 * remainder of the process — there is no `revert` story (see
 * design note below). The only re-entry path is calling
 * `applyRepositoryPatches` again after install, which is a no-op.
 */
let installed = false;

/**
 * Captured original of `Repository.prototype.extend` for the wrapper
 * to delegate into. Captured once at install-time; never restored.
 */
let originalExtend: typeof Repository.prototype.extend | undefined;

/**
 * Install the prototype-level patches that make every `Repository`
 * instance transactionally aware. Idempotent — calling more than
 * once per process is a no-op.
 *
 * Two patches:
 *
 * 1. `Repository.prototype.manager` — replaced with a getter/setter
 *    pair. The setter intercepts the constructor's
 *    `this.manager = manager` assignment and stashes the value
 *    under {@link TYPEORM_ENTITY_MANAGER_NAME}; the getter consults
 *    `TransactionContext` and returns the active transactional
 *    `EntityManager` when one exists for this repository's
 *    dataSource (falling back to the stashed original otherwise).
 *
 *    Since TypeORM's `Repository` methods are all of the shape
 *    `return this.manager.<method>(this.metadata.target, ...)`, this
 *    single getter patch transparently routes every public Repository
 *    operation (save, find, findOne, update, delete, query,
 *    createQueryBuilder, count, exists, sum, average, ...) through
 *    the transactional EntityManager when a transaction is active.
 *
 * 2. `Repository.prototype.extend` — wrapped so that a custom
 *    repository class produced via `repo.extend(...)` keeps the
 *    {@link TYPEORM_ENTITY_MANAGER_NAME} stamp on each constructed
 *    instance. Without this wrap, `.extend()` chains end up with
 *    `this.manager` undefined inside the patched getter (because the
 *    extended class re-runs the assignment that the patched setter
 *    consumes — but the setter only stashes; nothing else
 *    initializes the stash on the extended subclass).
 *
 *    The mirror `EntityManager.prototype.getRepository` wrap lives
 *    in `entity-manager-patches.ts` so the symmetry is obvious from
 *    the file layout.
 *
 * **Design note — no revert path.** Reverting a prototype patch by
 * deleting the descriptor would silently break every `Repository`
 * instance constructed under the patched setter — those instances
 * have no own-property `manager` (the setter only stashed the
 * value); deleting the prototype descriptor leaves their
 * `repo.manager` as `undefined`. Tests that need isolation should
 * destroy and recreate the `DataSource` instead, which causes
 * `TypeORM`'s `EntityManager`/`Repository` cache to be replaced
 * along with the DataSource. The `WeakSet`-based managed-DataSource
 * registry (see `managed-registry.ts`) provides the test-isolation
 * lever that *is* safe to flip: after `resetManagedRegistry()`,
 * cached repositories from the prior test fall through the
 * patched getter to their captured original manager (autocommit) —
 * never a broken `undefined`.
 */
export function applyRepositoryPatches(): void {
  if (installed) {
    return;
  }

  // (1) Repository.prototype.manager — getter/setter pair.
  Object.defineProperty(Repository.prototype, 'manager', {
    configurable: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(this: Repository<any>): EntityManager {
      // The original (non-active) manager is stashed under our
      // symbol by either: (a) the patched `set` below, when
      // TypeORM's Repository constructor runs `this.manager = manager`,
      // or (b) the `EntityManager.prototype.getRepository` wrapper
      // when it stamps newly-resolved repositories.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const original: EntityManager | undefined = (this as any)[TYPEORM_ENTITY_MANAGER_NAME];

      // Defensive: a Repository ending up here without ever having
      // had its setter called (shouldn't happen in practice) yields
      // `undefined`, mirroring the pre-patch behaviour for an
      // unconstructed/zombie instance.
      if (original === undefined) {
        return undefined as unknown as EntityManager;
      }

      const ds = original.connection;
      if (!isManaged(ds)) {
        return original;
      }

      const dsName = getManagedDataSourceName(ds);
      if (dsName === undefined) {
        return original;
      }

      const active = getActiveEntityManager(dsName);
      return active ?? original;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set(this: Repository<any>, manager: EntityManager): void {
      // Constructor's `this.manager = manager` reaches us here.
      // Stash under the hidden symbol so the getter has a fallback.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)[TYPEORM_ENTITY_MANAGER_NAME] = manager;
    },
  });

  // (2) Repository.prototype.extend — wrap to preserve the stash on
  // extended instances. The generic shape of the original
  // `extend` resists clean typing on the wrapper; cast through
  // `any` to keep the wrap a single statement (the runtime
  // contract is unchanged).
  originalExtend = Repository.prototype.extend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Repository.prototype as any).extend = function patchedExtend(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this: Repository<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customs: any,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = originalExtend!.call(this, customs);
    // The freshly-extended Repository was constructed via the
    // patched setter, so the stash is already in place. Defensive
    // copy in case TypeORM's internal extension shape changes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any)[TYPEORM_ENTITY_MANAGER_NAME] === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[TYPEORM_ENTITY_MANAGER_NAME] = (this as any)[TYPEORM_ENTITY_MANAGER_NAME];
    }
    return result;
  };

  installed = true;
}

/**
 * Predicate exported for unit tests. @internal
 */
export function areRepositoryPatchesApplied(): boolean {
  return installed;
}
