/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
// The patching machinery wraps `EntityManager.prototype.getRepository`
// and stamps hidden symbol-keyed properties on returned
// `Repository` instances. These properties live outside TypeORM's
// public types by design, so unsafe-access and unbound-method
// lint rules fire on every access. File-level disable keeps the
// patch code readable; the runtime contract is documented in the
// JSDoc above each patch.

import { EntityManager } from 'typeorm';

import { TYPEORM_ENTITY_MANAGER_NAME } from './symbols';

/**
 * Tracks whether `EntityManager.prototype.getRepository` has been
 * wrapped. Idempotent install pattern matching
 * `repository-patches.ts` — once installed, the wrap lives for the
 * remainder of the process. See repository-patches.ts JSDoc for
 * the design-note rationale.
 */
let installed = false;

/**
 * Captured original of `EntityManager.prototype.getRepository` for
 * the wrapper to delegate into.
 */
let originalGetRepository: typeof EntityManager.prototype.getRepository | undefined;

/**
 * Wrap `EntityManager.prototype.getRepository` so the resulting
 * `Repository` instance carries the {@link TYPEORM_ENTITY_MANAGER_NAME}
 * stamp pointing at this `EntityManager`. The patched
 * `Repository.prototype.manager` getter then has a stable fallback
 * (the original, non-active manager) and a way to discover the
 * dataSource name (via `original.connection`).
 *
 * This wrap matters specifically for the
 * `@InjectEntityManager() em.getRepository(Entity).save(...)` user
 * pattern (Phase 14.20 Q1 Option A coverage proof): the injected
 * `EntityManager` is the DataSource's default (non-transactional)
 * manager. Calling `em.getRepository(Entity)` would, without this
 * wrap, return a Repository whose only `manager` reference is `em`
 * itself — and the patched `Repository.prototype.manager` getter
 * would have nothing to read. With the wrap, the returned repo
 * carries `em` under the stash symbol, the getter resolves the
 * dataSource name from `em.connection`, and the lookup proceeds
 * normally. Net effect: even when reaching a Repository through
 * `@InjectEntityManager`, the active transactional EntityManager is
 * still used.
 *
 * `@InjectEntityManager` + direct method call (`em.save(Entity, ...)`)
 * is NOT covered by this patch — that is the documented limitation
 * (Phase 14.20 Q5). Use `getCurrentEntityManager()` as the escape
 * hatch.
 */
export function applyEntityManagerPatches(): void {
  if (installed) {
    return;
  }

  originalGetRepository = EntityManager.prototype.getRepository;

  // The generic shape of `getRepository<Entity>` resists clean
  // typing on a wrapper; cast through `any` to keep the wrap a
  // single statement. Runtime contract is unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (EntityManager.prototype as any).getRepository = function patchedGetRepository(
    this: EntityManager,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    target: any,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const repo = originalGetRepository!.call(this, target);
    // Stamp the EM if not already set. EntityManager has internal
    // caching, so the same Repository may be returned for repeat
    // calls — re-stamping with the same value is a no-op, but the
    // guard makes the intent explicit.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((repo as any)[TYPEORM_ENTITY_MANAGER_NAME] === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (repo as any)[TYPEORM_ENTITY_MANAGER_NAME] = this;
    }
    return repo;
  };

  installed = true;
}

/** Predicate exported for unit tests. @internal */
export function areEntityManagerPatchesApplied(): boolean {
  return installed;
}
