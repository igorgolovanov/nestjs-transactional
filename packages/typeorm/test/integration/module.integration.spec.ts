import { Global, Injectable, Module, type Provider } from '@nestjs/common';
import {
  ADAPTER_REGISTRY,
  type AdapterRegistry,
  TransactionalModule,
  TransactionManager,
} from '@nestjs-transactional/core';
import { getDataSourceToken, InjectDataSource } from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';

import {
  getCurrentEntityManager,
  isInTransaction,
} from '../../src/helpers/get-entity-manager';
import { TypeOrmTransactionalModule } from '../../src/module/typeorm-transactional.module';
import {
  createAdditionalDatabase,
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';
import { TestUser } from '../shared/test-user.entity';

/**
 * Stand-in for `TypeOrmModule.forRoot(...)` — registers the
 * `getDataSourceToken(name)` providers in a `@Global()` module
 * so child modules (notably `TypeOrmTransactionalModule`) can
 * resolve them. In a real app `@nestjs/typeorm` already provides
 * this global visibility.
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

@Injectable()
class UserService {
  save(name: string): Promise<TestUser> {
    const em = getCurrentEntityManager();
    return em.save(TestUser, { name });
  }
}

@Injectable()
class BillingService {
  save(name: string): Promise<TestUser> {
    const em = getCurrentEntityManager('billing');
    return em.save(TestUser, { name });
  }
}

@Injectable()
class UserServiceWithFallback {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  save(name: string): Promise<TestUser> {
    // Pass DS as fallback — returns ds.manager when no active tx.
    const em = getCurrentEntityManager('unregistered', this.ds);
    return em.save(TestUser, { name });
  }
}

describe('TypeOrmTransactionalModule (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;

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
  });

  describe('basic @Transactional + getCurrentEntityManager integration', () => {
    let moduleRef: TestingModule;
    let manager: TransactionManager;
    let userService: UserService;

    beforeAll(async () => {
      // Reset static state before this describe builds its module.
      // Each top-level `describe` is its own ownership boundary;
      // sibling describes do NOT share infrastructure singletons.
      TransactionalModule.resetForTesting();
      TypeOrmTransactionalModule.resetForTesting();

      moduleRef = await Test.createTestingModule({
        imports: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          buildFakeTypeOrmModule([
            { provide: getDataSourceToken(), useValue: ctx.dataSource },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ]) as any,
          TransactionalModule.forRoot({ isGlobal: true }),
          TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        ],
        providers: [UserService],
      }).compile();
      await moduleRef.init();

      manager = moduleRef.get(TransactionManager);
      userService = moduleRef.get(UserService);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('persists the user when manager.run commits', async () => {
      await manager.run({}, async () => {
        expect(isInTransaction()).toBe(true);
        await userService.save('alice');
      });

      const users = await ctx.dataSource.getRepository(TestUser).find();
      expect(users.map((u) => u.name)).toEqual(['alice']);
    });

    it('rolls back when the body throws — no user persisted', async () => {
      const boom = new Error('boom');

      await expect(
        manager.run({}, async () => {
          await userService.save('alice');
          throw boom;
        }),
      ).rejects.toBe(boom);

      const users = await ctx.dataSource.getRepository(TestUser).find();
      expect(users).toHaveLength(0);
    });
  });

  describe('multi-datasource: primary + billing', () => {
    let billingDs: DataSource;
    let moduleRef: TestingModule;
    let manager: TransactionManager;
    let userService: UserService;
    let billingService: BillingService;

    beforeAll(async () => {
      TransactionalModule.resetForTesting();
      TypeOrmTransactionalModule.resetForTesting();

      billingDs = await createAdditionalDatabase(ctx, 'billing_test', {
        entities: [TestUser],
        synchronize: true,
      });

      moduleRef = await Test.createTestingModule({
        imports: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          buildFakeTypeOrmModule([
            { provide: getDataSourceToken(), useValue: ctx.dataSource },
            { provide: getDataSourceToken('billing'), useValue: billingDs },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ]) as any,
          TransactionalModule.forRoot({ isGlobal: true }),
          // Default DS — bound to ctx.dataSource via the
          // `getDataSourceToken()` provider above. Marked as the
          // registry default so `getCurrentEntityManager()` (no arg)
          // resolves to it; the prior test's `UserService.save` uses
          // that exact lookup.
          TypeOrmTransactionalModule.forRoot({ isDefault: true }),
          TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),
        ],
        providers: [UserService, BillingService],
      }).compile();
      await moduleRef.init();

      manager = moduleRef.get(TransactionManager);
      userService = moduleRef.get(UserService);
      billingService = moduleRef.get(BillingService);
    });

    afterAll(async () => {
      await moduleRef.close();
      await billingDs.destroy();
    });

    beforeEach(async () => {
      await ctx.dataSource.getRepository(TestUser).clear();
      await billingDs.getRepository(TestUser).clear();
    });

    it('routes writes to the billing DataSource when adapterInstance: "billing" is set', async () => {
      await manager.run({ adapterInstance: 'billing' }, async () => {
        await billingService.save('billed-user');
      });

      const billingUsers = await billingDs.getRepository(TestUser).find();
      const primaryUsers = await ctx.dataSource.getRepository(TestUser).find();

      expect(billingUsers.map((u) => u.name)).toEqual(['billed-user']);
      expect(primaryUsers).toHaveLength(0);
    });

    it('registers adapters under both instance names in the shared AdapterRegistry', async () => {
      const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);

      expect(registry.get('typeorm', 'default')).toBeDefined();
      expect(registry.get('typeorm', 'billing')).toBeDefined();
      expect(registry.getDefaultInstanceName()).toBe('default');
    });

    it('writes go to the default DataSource when adapterInstance is not set', async () => {
      await manager.run({}, async () => {
        await userService.save('default-user');
      });

      const defaultUsers = await ctx.dataSource.getRepository(TestUser).find();
      const billingUsers = await billingDs.getRepository(TestUser).find();

      expect(defaultUsers.map((u) => u.name)).toEqual(['default-user']);
      expect(billingUsers).toHaveLength(0);
    });

    // ----------------------------------------------------------------
    // Phase 14.2 syntax: `manager.run({ dataSource: '...' })` routes
    // through `AdapterRegistry.getByDataSource(name)` to find the
    // adapter registered under the matching dataSource name.
    // ----------------------------------------------------------------

    it('routes writes to billing using Phase 14.2 syntax `manager.run({ dataSource })`', async () => {
      await manager.run({ dataSource: 'billing' }, async () => {
        await billingService.save('billed-via-new-syntax');
      });

      const billingUsers = await billingDs.getRepository(TestUser).find();
      const primaryUsers = await ctx.dataSource.getRepository(TestUser).find();

      expect(billingUsers.map((u) => u.name)).toEqual(['billed-via-new-syntax']);
      expect(primaryUsers).toHaveLength(0);
    });

    it('legacy `adapterInstance` and Phase 14.2 `dataSource` options are interchangeable', async () => {
      // Same logical operation, two equivalent ways to spell it.
      await manager.run({ adapterInstance: 'billing' }, async () => {
        await billingService.save('legacy-syntax');
      });
      await manager.run({ dataSource: 'billing' }, async () => {
        await billingService.save('phase-14-2-syntax');
      });

      const billingNames = (await billingDs.getRepository(TestUser).find())
        .map((u) => u.name)
        .sort();
      expect(billingNames).toEqual(['legacy-syntax', 'phase-14-2-syntax']);
    });

    it('keeps cross-dataSource transactions isolated when nested', async () => {
      await manager.run({ dataSource: 'billing' }, async () => {
        await billingService.save('outer-billing');

        await manager.run({ dataSource: 'default' }, async () => {
          await userService.save('inner-default');
        });

        // After inner commits, billing tx is still active.
        await billingService.save('billing-after-inner');
      });

      const billingNames = (await billingDs.getRepository(TestUser).find())
        .map((u) => u.name)
        .sort();
      const defaultNames = (await ctx.dataSource.getRepository(TestUser).find())
        .map((u) => u.name)
        .sort();

      expect(billingNames).toEqual(['billing-after-inner', 'outer-billing']);
      expect(defaultNames).toEqual(['inner-default']);
    });

    it('rolls back the inner transaction without affecting the outer dataSource', async () => {
      const outerThrew = await manager
        .run({ dataSource: 'billing' }, async () => {
          await billingService.save('billing-committed');

          await expect(
            manager.run({ dataSource: 'default' }, async () => {
              await userService.save('default-rolled-back');
              throw new Error('force inner rollback');
            }),
          ).rejects.toThrow('force inner rollback');

          // billing tx still alive after inner rollback — write more.
          await billingService.save('billing-after-rollback');
        })
        .then(() => false)
        .catch(() => true);

      expect(outerThrew).toBe(false);
      expect((await billingDs.getRepository(TestUser).find()).map((u) => u.name).sort()).toEqual([
        'billing-after-rollback',
        'billing-committed',
      ]);
      expect(await ctx.dataSource.getRepository(TestUser).count()).toBe(0);
    });
  });

  describe('without adapter registration — fallback via @InjectDataSource', () => {
    let moduleRef: TestingModule;
    let svc: UserServiceWithFallback;

    beforeAll(async () => {
      TransactionalModule.resetForTesting();
      TypeOrmTransactionalModule.resetForTesting();

      moduleRef = await Test.createTestingModule({
        imports: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          buildFakeTypeOrmModule([
            { provide: getDataSourceToken(), useValue: ctx.dataSource },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ]) as any,
          TransactionalModule.forRoot({ isGlobal: true }),
        ],
        providers: [UserServiceWithFallback],
      }).compile();
      await moduleRef.init();

      svc = moduleRef.get(UserServiceWithFallback);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('falls back to DataSource.manager when no adapter is registered for the instance', async () => {
      await svc.save('no-tx-user');

      const users = await ctx.dataSource.getRepository(TestUser).find();
      expect(users.map((u) => u.name)).toEqual(['no-tx-user']);
    });
  });
});
