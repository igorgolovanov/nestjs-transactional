import { Injectable } from '@nestjs/common';
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
    await ctx.dataSource.getRepository(TestUser).clear();
  });

  describe('basic @Transactional + getCurrentEntityManager integration', () => {
    let moduleRef: TestingModule;
    let manager: TransactionManager;
    let userService: UserService;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ isGlobal: true }),
          TypeOrmTransactionalModule.forFeature({
            dataSource: ctx.dataSource,
            isDefault: true,
          }),
        ],
        providers: [
          UserService,
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
        ],
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
      billingDs = await createAdditionalDatabase(ctx, 'billing_test', {
        entities: [TestUser],
        synchronize: true,
      });

      moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ isGlobal: true }),
          TypeOrmTransactionalModule.forFeature({
            dataSource: ctx.dataSource,
            instanceName: 'primary',
            isDefault: true,
          }),
          TypeOrmTransactionalModule.forFeature({
            dataSource: billingDs,
            instanceName: 'billing',
          }),
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

      expect(registry.get('typeorm', 'primary')).toBeDefined();
      expect(registry.get('typeorm', 'billing')).toBeDefined();
      expect(registry.getDefaultInstanceName()).toBe('primary');
    });

    it('writes go to primary when adapterInstance is not set (default)', async () => {
      await manager.run({}, async () => {
        await userService.save('primary-user');
      });

      const primaryUsers = await ctx.dataSource.getRepository(TestUser).find();
      const billingUsers = await billingDs.getRepository(TestUser).find();

      expect(primaryUsers.map((u) => u.name)).toEqual(['primary-user']);
      expect(billingUsers).toHaveLength(0);
    });
  });

  describe('without adapter registration — fallback via @InjectDataSource', () => {
    let moduleRef: TestingModule;
    let svc: UserServiceWithFallback;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [TransactionalModule.forRoot({ isGlobal: true })],
        providers: [
          UserServiceWithFallback,
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
        ],
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
