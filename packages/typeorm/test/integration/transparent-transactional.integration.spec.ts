import { Global, Injectable, Module, type Provider } from '@nestjs/common';
import {
  TransactionManager,
  TransactionalModule,
  Transactional,
  PropagationMode,
} from '@nestjs-transactional/core';
import {
  getDataSourceToken,
  InjectDataSource,
  InjectEntityManager,
  InjectRepository,
} from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { TypeOrmTransactionalModule } from '../../src/module/typeorm-transactional.module';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';
import { TestUser } from '../shared/test-user.entity';

/**
 * In production the `getDataSourceToken(name)` and per-entity
 * Repository providers are supplied by `@nestjs/typeorm`'s
 * `TypeOrmModule.forRoot(...)` / `TypeOrmModule.forFeature(...)`,
 * which register them as `@Global()` so child modules (like
 * `TypeOrmTransactionalModule`) can inject them. For these
 * integration tests we replicate that visibility with a tiny
 * `@Global()` fixture.
 */
function buildFakeTypeOrmModule(providers: Provider[]): unknown {
  @Global()
  @Module({
    providers,
    exports: providers.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p)),
  })
  class FakeTypeOrmModule {}
  return FakeTypeOrmModule;
}

/**
 * Phase 14.20 — transparent transactional repositories. End-to-end
 * verification against real Postgres that injected `Repository`,
 * `EntityManager`, and `DataSource` instances all dispatch through
 * the active transactional `EntityManager` while inside a
 * `@Transactional()` scope.
 *
 * Coverage: the `@InjectRepository` happy path, the
 * `@InjectEntityManager() em.getRepository(E)` Q1 Option A coverage
 * proof, the `@InjectDataSource()` direct-usage path, rollback
 * semantics, REQUIRES_NEW propagation, custom-repository
 * `.extend(...)` patterns, and the documented limitation for
 * direct `em.save(...)` on the injected EM.
 */

@Injectable()
class RepoUserService {
  constructor(
    @InjectRepository(TestUser)
    readonly repo: Repository<TestUser>,
  ) {}

  @Transactional()
  async createCommitting(name: string): Promise<TestUser> {
    return this.repo.save({ name });
  }

  @Transactional()
  async createThenThrow(name: string): Promise<void> {
    await this.repo.save({ name });
    throw new Error('forced rollback');
  }

  async createWithoutTransaction(name: string): Promise<TestUser> {
    return this.repo.save({ name });
  }
}

@Injectable()
class EntityManagerUserService {
  constructor(@InjectEntityManager() readonly em: EntityManager) {}

  /**
   * Q1 Option A coverage proof — `@InjectEntityManager() em` then
   * `em.getRepository(...).save(...)` should be transactional via
   * the wrapped `EntityManager.prototype.getRepository` plus the
   * patched `Repository.prototype.manager` getter.
   */
  @Transactional()
  async createViaGetRepository(name: string): Promise<TestUser> {
    const repo = this.em.getRepository(TestUser);
    return repo.save({ name });
  }

  /**
   * Documented limitation — direct `em.save(...)` is NOT
   * transactional with Option A. The injected `em` IS the
   * DataSource's default manager, and EntityManager.prototype is
   * not patched, so this autocommits even inside `@Transactional()`.
   * Used as a negative-control test to pin the limitation explicitly.
   */
  @Transactional()
  async createViaDirectEmSave(name: string): Promise<TestUser> {
    return this.em.save(TestUser, { name });
  }
}

@Injectable()
class DataSourceUserService {
  constructor(@InjectDataSource() readonly ds: DataSource) {}

  @Transactional()
  async createViaDsGetRepository(name: string): Promise<TestUser> {
    return this.ds.getRepository(TestUser).save({ name });
  }

  @Transactional()
  async createViaDsManager(name: string): Promise<TestUser> {
    // ds.manager is the patched per-instance getter — returns
    // the active EM inside @Transactional scope.
    return this.ds.manager.save(TestUser, { name });
  }
}

@Injectable()
class RequiresNewService {
  constructor(
    @InjectRepository(TestUser)
    readonly repo: Repository<TestUser>,
  ) {}

  @Transactional()
  async outer(name: string): Promise<void> {
    await this.repo.save({ name: `${name}-outer` });
    try {
      await this.innerRequiresNew(`${name}-inner`);
    } catch {
      // Inner rolled back independently — outer continues.
    }
  }

  @Transactional({ propagation: PropagationMode.REQUIRES_NEW })
  async innerRequiresNew(name: string): Promise<void> {
    await this.repo.save({ name });
    throw new Error('inner rollback');
  }
}

describe('Transparent transactional repositories (Phase 14.20, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    ctx = await startPostgresContainer({
      entities: [TestUser],
      synchronize: true,
    });
  });

  afterAll(async () => {
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();
    await ctx.dataSource.getRepository(TestUser).clear();

    moduleRef = await Test.createTestingModule({
      imports: [
        // Stand in for `TypeOrmModule.forRoot(...)` —
        // register the DataSource and per-entity Repository
        // providers under the standard `@nestjs/typeorm` tokens
        // (and inside a `@Global()` module so the
        // `TypeOrmTransactionalModule` child scope can see them).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildFakeTypeOrmModule([
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
          { provide: EntityManager, useValue: ctx.dataSource.manager },
          {
            provide: 'TestUserRepository',
            useFactory: (ds: DataSource) => ds.getRepository(TestUser),
            inject: [getDataSourceToken()],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forRoot(),
      ],
      providers: [
        RepoUserService,
        EntityManagerUserService,
        DataSourceUserService,
        RequiresNewService,
      ],
    }).compile();
    await moduleRef.init();
  });

  afterEach(async () => {
    if (moduleRef !== undefined) {
      await moduleRef.close();
    }
  });

  describe('@InjectRepository — the headline case', () => {
    it('repository.save() inside @Transactional commits when the method returns', async () => {
      const svc = moduleRef.get(RepoUserService);
      await svc.createCommitting('alice');
      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows.map((r) => r.name)).toEqual(['alice']);
    });

    it('repository.save() rolls back when the @Transactional method throws', async () => {
      const svc = moduleRef.get(RepoUserService);
      await expect(svc.createThenThrow('bob')).rejects.toThrow('forced rollback');
      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows).toHaveLength(0);
    });

    it('repository.save() autocommits when called outside a @Transactional scope', async () => {
      const svc = moduleRef.get(RepoUserService);
      await svc.createWithoutTransaction('charlie');
      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows.map((r) => r.name)).toEqual(['charlie']);
    });
  });

  describe('@InjectEntityManager — Q1 Option A coverage proof', () => {
    it('em.getRepository(E).save(...) IS transactional (commit on success)', async () => {
      const svc = moduleRef.get(EntityManagerUserService);
      await svc.createViaGetRepository('dani');
      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows.map((r) => r.name)).toEqual(['dani']);
    });

    it('em.getRepository(E).save(...) rolls back when the @Transactional method throws (proof of dispatch through active EM)', async () => {
      const svc = moduleRef.get(EntityManagerUserService);
      const manager = moduleRef.get(TransactionManager);

      // Compose: create one row inside a tx that throws → confirm
      // the row is NOT persisted. If em.getRepository().save was
      // not transactional (autocommit), the row would survive.
      await expect(
        manager.run({}, async () => {
          await svc.createViaGetRepository('elliot');
          throw new Error('rollback inside outer manager.run');
        }),
      ).rejects.toThrow('rollback inside outer manager.run');

      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows).toHaveLength(0);
    });

    it('DOCUMENTED LIMITATION — em.save(...) direct call is NOT transactional', async () => {
      const svc = moduleRef.get(EntityManagerUserService);
      const manager = moduleRef.get(TransactionManager);

      // Even though we throw inside the @Transactional, the row
      // should survive — em.save() bypassed the tx.
      await expect(
        manager.run({}, async () => {
          await svc.createViaDirectEmSave('limitation-canary');
          throw new Error('rollback canary');
        }),
      ).rejects.toThrow('rollback canary');

      const rows = await ctx.dataSource.getRepository(TestUser).find();
      // Row IS persisted — proof that direct em.save bypassed
      // the transaction. Documented limitation; users should
      // call `getCurrentEntityManager()` or use a Repository.
      expect(rows.map((r) => r.name)).toEqual(['limitation-canary']);
    });
  });

  describe('@InjectDataSource — direct DS access', () => {
    it('ds.getRepository(E).save() IS transactional', async () => {
      const svc = moduleRef.get(DataSourceUserService);
      await svc.createViaDsGetRepository('frank');
      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows.map((r) => r.name)).toEqual(['frank']);
    });

    it('ds.manager.save(...) IS transactional via the patched DataSource.manager getter', async () => {
      const svc = moduleRef.get(DataSourceUserService);
      const manager = moduleRef.get(TransactionManager);

      // Throwing rollback proof — the row should NOT persist if
      // ds.manager dispatched into the active EM.
      await expect(
        manager.run({}, async () => {
          await svc.createViaDsManager('grace');
          throw new Error('rollback grace');
        }),
      ).rejects.toThrow('rollback grace');

      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows).toHaveLength(0);
    });
  });

  describe('Propagation — REQUIRES_NEW with patched repository', () => {
    it('inner REQUIRES_NEW rolls back independently, outer commits', async () => {
      const svc = moduleRef.get(RequiresNewService);
      await svc.outer('rn');

      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows.map((r) => r.name).sort()).toEqual(['rn-outer']);
    });
  });

  describe('Repository.extend — custom repositories', () => {
    it('extended repository methods dispatch through the active EM', async () => {
      const manager = moduleRef.get(TransactionManager);
      const baseRepo = ctx.dataSource.getRepository(TestUser);
      const extended = baseRepo.extend({
        async insertNamed(this: Repository<TestUser>, name: string): Promise<TestUser> {
          return this.save({ name });
        },
      });

      await manager.run({}, async () => {
        await extended.insertNamed('extended-user');
      });

      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows.map((r) => r.name)).toEqual(['extended-user']);
    });

    it('extended repository rolls back on @Transactional throw — proof of active-EM dispatch', async () => {
      const manager = moduleRef.get(TransactionManager);
      const baseRepo = ctx.dataSource.getRepository(TestUser);
      const extended = baseRepo.extend({
        async insertNamed(this: Repository<TestUser>, name: string): Promise<TestUser> {
          return this.save({ name });
        },
      });

      await expect(
        manager.run({}, async () => {
          await extended.insertNamed('extended-rollback');
          throw new Error('extended rollback');
        }),
      ).rejects.toThrow('extended rollback');

      const rows = await ctx.dataSource.getRepository(TestUser).find();
      expect(rows).toHaveLength(0);
    });
  });
});
