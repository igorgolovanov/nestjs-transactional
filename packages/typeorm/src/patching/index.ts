/**
 * Phase 14.20 transparent transactional repositories — patching
 * machinery. Exported so the module layer can drive `applyAllPatches`
 * in `forRoot`, and so unit tests can probe state directly. None of
 * these symbols are intended for application code — public API stays
 * `getCurrentEntityManager` / `@Transactional` / `@InjectRepository`.
 *
 * @internal
 */

import { applyEntityManagerPatches } from './entity-manager-patches';
import { resetManagedRegistry } from './managed-registry';
import { applyRepositoryPatches } from './repository-patches';

export {
  applyRepositoryPatches,
  areRepositoryPatchesApplied,
} from './repository-patches';
export {
  applyEntityManagerPatches,
  areEntityManagerPatchesApplied,
} from './entity-manager-patches';
export { patchDataSourceInstance } from './data-source-patches';
export {
  getActiveEntityManager,
  getManagedDataSourceName,
  isManaged,
  markAsManaged,
  resetManagedRegistry,
} from './managed-registry';
export {
  TYPEORM_DATA_SOURCE_NAME,
  TYPEORM_DATA_SOURCE_PATCHED,
  TYPEORM_ENTITY_MANAGER_NAME,
} from './symbols';

/**
 * Apply both prototype-level patch families in one call. Used by
 * `TypeOrmTransactionalModule.forRoot`'s registration factory.
 * Idempotent — calling more than once is a no-op (each install
 * routine guards on its own `installed` flag).
 *
 * Per-instance DataSource patches ({@link patchDataSourceInstance})
 * are NOT included here because they apply to a specific instance
 * and are driven separately at registration time, also idempotent.
 */
export function applyAllPatches(): void {
  applyRepositoryPatches();
  applyEntityManagerPatches();
}

/**
 * Test-only — drop the managed-DataSources WeakSet so cached
 * repositories from a prior test fall through the patched getter
 * to their captured original manager (autocommit), as if the
 * patches were never engaged.
 *
 * Prototype-level patches are NOT removed — they were installed
 * once-and-stay (see `repository-patches.ts` design note for the
 * rationale: removing a prototype getter would silently break
 * Repository instances constructed under the patched setter that
 * have no own-property `manager`).
 *
 * Per-instance DataSource patches survive on those DataSource
 * instances; tests that destroy and recreate the DataSource
 * between cases (the typical pattern) are unaffected. The
 * idempotent-marker design (`TYPEORM_DATA_SOURCE_PATCHED`)
 * additionally makes re-registering the SAME `DataSource` after
 * `resetManagedRegistry` safe — `patchDataSourceInstance` becomes
 * a no-op.
 *
 * @internal
 */
export function resetPatchingForTesting(): void {
  resetManagedRegistry();
}
