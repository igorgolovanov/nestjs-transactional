import { TransactionContext } from '@nestjs-transactional/core';
import { Column, DataSource, Entity, EntityManager, PrimaryGeneratedColumn, Repository } from 'typeorm';

import type { TypeOrmTransactionHandle } from '../types/typeorm-transaction-handle';

import { patchDataSourceInstance } from './data-source-patches';
import { applyEntityManagerPatches } from './entity-manager-patches';
import { markAsManaged, resetManagedRegistry } from './managed-registry';
import {
  applyRepositoryPatches,
  areRepositoryPatchesApplied,
} from './repository-patches';
import { TYPEORM_ENTITY_MANAGER_NAME } from './symbols';

@Entity({ name: 'patch_test_users' })
class PatchTestUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

async function createSqlJsDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [PatchTestUser],
  });
  await ds.initialize();
  return ds;
}

/**
 * Run `fn` inside a synthetic active transaction registered under
 * `typeorm:${dataSource}`. Mirrors the shape `TransactionManager`
 * writes and `getCurrentEntityManager` reads — so the patches see
 * the same context they will encounter in production.
 */
async function withFakeActiveTx<T>(
  dataSource: string,
  entityManager: EntityManager,
  fn: () => Promise<T>,
): Promise<T> {
  const handle: TypeOrmTransactionHandle = {
    id: `tx-${dataSource}`,
    adapterName: 'typeorm',
    entityManager,
  };
  return TransactionContext.run(`corr-${dataSource}`, async () => {
    TransactionContext.setActiveTransaction(`typeorm:${dataSource}`, {
      handle,
      adapterName: 'typeorm',
      adapterInstanceName: dataSource,
      options: {},
      startedAt: new Date(),
      afterCommitHooks: [],
      afterRollbackHooks: [],
      beforeCommitHooks: [],
      correlationId: `corr-${dataSource}`,
    });
    return fn();
  });
}

describe('repository-patches', () => {
  // Patches are installed once-per-process by design (see
  // repository-patches.ts JSDoc). These tests exercise the
  // already-installed patches — a fresh `applyRepositoryPatches`
  // call per test would be a no-op anyway. The managed registry,
  // however, IS test-scoped and is reset in `afterEach`.
  beforeAll(() => {
    applyRepositoryPatches();
    applyEntityManagerPatches();
  });

  afterEach(() => {
    resetManagedRegistry();
  });

  it('applyRepositoryPatches is idempotent (multiple calls are no-ops)', () => {
    expect(areRepositoryPatchesApplied()).toBe(true);
    applyRepositoryPatches();
    applyRepositoryPatches();
    expect(areRepositoryPatchesApplied()).toBe(true);
  });

  it('Repository.prototype.manager getter is installed on the prototype', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Repository.prototype, 'manager');
    expect(descriptor).toBeDefined();
    expect(typeof descriptor?.get).toBe('function');
    expect(typeof descriptor?.set).toBe('function');
  });

  it('Repository constructor stashes the manager under the hidden symbol via the patched setter', async () => {
    const ds = await createSqlJsDataSource();
    try {
      const repo = ds.getRepository(PatchTestUser);
      // The prototype getter should resolve to ds.manager (the
      // original) when no transaction is active.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((repo as any)[TYPEORM_ENTITY_MANAGER_NAME]).toBe(ds.manager);
      expect(repo.manager).toBe(ds.manager);
    } finally {
      await ds.destroy();
    }
  });

  it('repository.manager returns the ACTIVE EntityManager when one is registered for its dataSource', async () => {
    const ds = await createSqlJsDataSource();
    try {
      markAsManaged(ds, 'default');
      patchDataSourceInstance(ds);

      const repo = ds.getRepository(PatchTestUser);

      // Build a synthetic "transactional" EntityManager. In
      // production this would be the EM TypeORM creates inside
      // dataSource.transaction; for the unit test, any distinct
      // instance proves the dispatch.
      const txEm = new EntityManager(ds);

      await withFakeActiveTx('default', txEm, async () => {
        expect(repo.manager).toBe(txEm);
      });

      // After the scope exits, the repo falls back to the
      // original manager.
      expect(repo.manager).not.toBe(txEm);
    } finally {
      await ds.destroy();
    }
  });

  it('repository.manager falls back to the original when the DataSource is NOT managed', async () => {
    const ds = await createSqlJsDataSource();
    try {
      // Intentionally do NOT call markAsManaged — even with an
      // active transaction registered against the same dataSource
      // name, the repo on a non-managed DS must not dispatch.
      const repo = ds.getRepository(PatchTestUser);
      const fakeTxEm = new EntityManager(ds);

      await withFakeActiveTx('default', fakeTxEm, async () => {
        expect(repo.manager).not.toBe(fakeTxEm);
        expect(repo.manager).toBe(ds.manager);
      });
    } finally {
      await ds.destroy();
    }
  });

  it('repository.manager falls back to the original when there is no active transaction for its dataSource', async () => {
    const ds = await createSqlJsDataSource();
    try {
      markAsManaged(ds, 'billing');
      patchDataSourceInstance(ds);
      const repo = ds.getRepository(PatchTestUser);

      // Active tx is for a DIFFERENT dataSource ('default') — the
      // repo lives on 'billing', so it must fall back to its own
      // original manager (Spring-style cross-DS isolation, DD-023).
      const otherTxEm = new EntityManager(ds);
      await withFakeActiveTx('default', otherTxEm, async () => {
        expect(repo.manager).not.toBe(otherTxEm);
      });
    } finally {
      await ds.destroy();
    }
  });

  it('em.getRepository(Entity) — the wrapped getRepository preserves the stamp so the returned repo dispatches transactionally (Q1 Option A coverage proof)', async () => {
    const ds = await createSqlJsDataSource();
    try {
      markAsManaged(ds, 'default');
      patchDataSourceInstance(ds);

      // Caller starts from `ds.manager` (i.e. the
      // @InjectEntityManager() injected EM in real use).
      const injectedEm = ds.manager;
      const repoFromEm = injectedEm.getRepository(PatchTestUser);

      // Stamp must be on the returned repo, pointing at the
      // injected EM (not the active EM).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((repoFromEm as any)[TYPEORM_ENTITY_MANAGER_NAME]).toBe(injectedEm);

      const txEm = new EntityManager(ds);
      await withFakeActiveTx('default', txEm, async () => {
        // Even though the user started from the injected EM, the
        // repo's manager getter resolves to the active EM.
        expect(repoFromEm.manager).toBe(txEm);
      });
    } finally {
      await ds.destroy();
    }
  });

  it('repository.extend(...) preserves the manager stamp on the extended repo', async () => {
    const ds = await createSqlJsDataSource();
    try {
      markAsManaged(ds, 'default');
      patchDataSourceInstance(ds);
      const baseRepo = ds.getRepository(PatchTestUser);

      const extended = baseRepo.extend({
        customMethod(): string {
          return 'custom';
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((extended as any)[TYPEORM_ENTITY_MANAGER_NAME]).toBe(ds.manager);

      const txEm = new EntityManager(ds);
      await withFakeActiveTx('default', txEm, async () => {
        expect(extended.manager).toBe(txEm);
      });
    } finally {
      await ds.destroy();
    }
  });

  it('cached repos created BEFORE markAsManaged still dispatch correctly once the DS is registered', async () => {
    const ds = await createSqlJsDataSource();
    try {
      // Build a repo BEFORE the DS is registered as managed —
      // this is the "test reset between cases" scenario: a repo
      // built in `beforeAll` survives across `resetManagedRegistry`
      // and re-registration.
      const repo = ds.getRepository(PatchTestUser);
      // Without managed status: falls back.
      expect(repo.manager).toBe(ds.manager);

      // Now register and re-test with active tx.
      markAsManaged(ds, 'default');
      patchDataSourceInstance(ds);

      const txEm = new EntityManager(ds);
      await withFakeActiveTx('default', txEm, async () => {
        expect(repo.manager).toBe(txEm);
      });
    } finally {
      await ds.destroy();
    }
  });
});
