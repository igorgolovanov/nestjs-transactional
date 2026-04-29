import { Global, Injectable, Module, type Provider } from '@nestjs/common';
import {
  PropagationMode,
  TransactionManager,
  Transactional,
  TransactionalModule,
} from '@nestjs-transactional/core';
import {
  getDataSourceToken,
  getRepositoryToken,
  InjectRepository,
} from '@nestjs/typeorm';
import { Test, type TestingModule } from '@nestjs/testing';
import { Column, DataSource, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';

import { TypeOrmTransactionalModule } from '../../src/module/typeorm-transactional.module';
import {
  createAdditionalDatabase,
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';

/**
 * Multi-DS scope — the entities are duplicated per dataSource so
 * that TypeORM's per-DataSource entity metadata cache stays clean
 * even when the same JS class is registered under multiple
 * connections. The simple alternative (one entity class on both
 * DSs) sometimes triggers metadata reuse warnings; isolated
 * classes avoid that for a focused multi-DS test suite.
 */
@Entity({ name: 'mds_orders' })
class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  description!: string;
}

@Entity({ name: 'mds_invoices' })
class Invoice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}

/**
 * `@nestjs/typeorm`'s `@InjectRepository(Entity, dataSource)`
 * resolves to a token like `${dataSource}EntityRepository`. We
 * stand in for the real `TypeOrmModule.forFeature` registration
 * by providing the Repository ourselves under that exact token.
 *
 * The factory deliberately calls `ds.getRepository(Entity)` —
 * because module-load-time patches install the `EntityManager`
 * `getRepository` wrapper and the `Repository.prototype.manager`
 * getter BEFORE this factory runs (file import side-effect), the
 * resulting `Repository` carries the stamp under the patched
 * setter. Confirms the cross-DS case where two distinct
 * DataSources each contribute their own injected Repository.
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
class OrderService {
  constructor(
    // Default DS (no second arg) — token is the Repository class
    // for default; we register under the same token in the fake
    // TypeOrm module below.
    @InjectRepository(Order)
    readonly orderRepo: Repository<Order>,
  ) {}

  @Transactional()
  async createOrder(description: string): Promise<Order> {
    return this.orderRepo.save({ description });
  }

  @Transactional({ dataSource: 'default' })
  async createOrderExplicit(description: string): Promise<Order> {
    return this.orderRepo.save({ description });
  }

  /**
   * Cross-DS case: declared `@Transactional({ dataSource: 'billing' })`
   * but writes to the *default*-DS Order repo. Per DD-023, the
   * billing transaction is active for billing only — this Repository
   * (default-DS) sees no active transaction for its dataSource and
   * autocommits. Spring-style cross-DS isolation: a transaction on
   * dataSource A does NOT silently enrol dataSource B.
   */
  @Transactional({ dataSource: 'billing' })
  async createOrderUnderBillingTx(description: string): Promise<Order> {
    return this.orderRepo.save({ description });
  }
}

@Injectable()
class InvoiceService {
  constructor(
    @InjectRepository(Invoice, 'billing')
    readonly invoiceRepo: Repository<Invoice>,
  ) {}

  @Transactional({ dataSource: 'billing' })
  async createInvoice(amount: number): Promise<Invoice> {
    return this.invoiceRepo.save({ amount });
  }

  @Transactional({ dataSource: 'billing' })
  async createInvoiceAndThrow(amount: number): Promise<void> {
    await this.invoiceRepo.save({ amount });
    throw new Error('billing rollback');
  }
}

@Injectable()
class CrossDsService {
  constructor(
    @InjectRepository(Order) readonly orderRepo: Repository<Order>,
    @InjectRepository(Invoice, 'billing') readonly invoiceRepo: Repository<Invoice>,
  ) {}

  /**
   * Inner-billing-transactional inside outer-default-transactional.
   * REQUIRED propagation; different dataSources → both transactions
   * coexist, billing tx commits first when its method returns,
   * default tx commits last. If outer throws after billing returns,
   * billing IS already committed (separate dataSource = separate
   * transaction lifecycle).
   *
   * This pins the DD-023 contract: cross-DS consistency is an
   * application-level concern; distributed transactions are NOT
   * supported.
   */
  @Transactional({ dataSource: 'default' })
  async createBoth(description: string, amount: number): Promise<void> {
    await this.orderRepo.save({ description });
    await this.invoiceForBilling(amount);
  }

  @Transactional({ dataSource: 'billing' })
  async invoiceForBilling(amount: number): Promise<Invoice> {
    return this.invoiceRepo.save({ amount });
  }

  @Transactional({ dataSource: 'default' })
  async createBothThenThrow(description: string, amount: number): Promise<void> {
    await this.orderRepo.save({ description });
    await this.invoiceForBilling(amount);
    throw new Error('default-side rollback');
  }
}

describe('Transparent transactional repositories — multi-DS (Phase 14.20)', () => {
  let ctx: PostgresTestContext;
  let billingDs: DataSource;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    ctx = await startPostgresContainer({
      entities: [Order],
      synchronize: true,
    });
    billingDs = await createAdditionalDatabase(ctx, 'mds_billing_test', {
      entities: [Invoice],
      synchronize: true,
    });
  });

  afterAll(async () => {
    await billingDs.destroy();
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();
    await ctx.dataSource.getRepository(Order).clear();
    await billingDs.getRepository(Invoice).clear();

    moduleRef = await Test.createTestingModule({
      imports: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildFakeTypeOrmModule([
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
          { provide: getDataSourceToken('billing'), useValue: billingDs },
          {
            provide: getRepositoryToken(Order),
            useFactory: (ds: DataSource) => ds.getRepository(Order),
            inject: [getDataSourceToken()],
          },
          {
            provide: getRepositoryToken(Invoice, 'billing'),
            useFactory: (ds: DataSource) => ds.getRepository(Invoice),
            inject: [getDataSourceToken('billing')],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),
      ],
      providers: [OrderService, InvoiceService, CrossDsService],
    }).compile();
    await moduleRef.init();
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  describe('per-dataSource @Transactional routing', () => {
    it('default-DS @Transactional commits to default DS, billing DS untouched', async () => {
      const svc = moduleRef.get(OrderService);
      await svc.createOrder('default-order');

      const orders = await ctx.dataSource.getRepository(Order).find();
      const invoices = await billingDs.getRepository(Invoice).find();
      expect(orders.map((o) => o.description)).toEqual(['default-order']);
      expect(invoices).toHaveLength(0);
    });

    it('billing-DS @Transactional commits to billing DS, default DS untouched', async () => {
      const svc = moduleRef.get(InvoiceService);
      await svc.createInvoice(42);

      const orders = await ctx.dataSource.getRepository(Order).find();
      const invoices = await billingDs.getRepository(Invoice).find();
      expect(orders).toHaveLength(0);
      expect(invoices.map((i) => i.amount)).toEqual([42]);
    });

    it('billing-DS @Transactional rollback isolates to billing DS', async () => {
      const svc = moduleRef.get(InvoiceService);
      await expect(svc.createInvoiceAndThrow(99)).rejects.toThrow('billing rollback');

      const invoices = await billingDs.getRepository(Invoice).find();
      expect(invoices).toHaveLength(0);
    });

    it('explicit @Transactional({ dataSource: "default" }) is equivalent to omitted dataSource', async () => {
      const svc = moduleRef.get(OrderService);
      await svc.createOrderExplicit('explicit-default');

      const orders = await ctx.dataSource.getRepository(Order).find();
      expect(orders.map((o) => o.description)).toEqual(['explicit-default']);
    });
  });

  describe('cross-DS isolation (DD-023)', () => {
    it('default-DS Repository inside a billing-DS transaction autocommits (no implicit cross-DS enrolment)', async () => {
      const svc = moduleRef.get(OrderService);
      const manager = moduleRef.get(TransactionManager);

      // Outer billing tx that throws AFTER calling the
      // default-DS Repository. The default-DS save commits
      // independently (it's not enrolled in the billing tx),
      // and the billing tx itself rolls back nothing because
      // it touched no billing rows. Net: 'cross-ds-order' IS
      // persisted on default DS.
      await expect(
        manager.run({ dataSource: 'billing' }, async () => {
          await svc.createOrderUnderBillingTx('cross-ds-order');
          throw new Error('billing tx rollback');
        }),
      ).rejects.toThrow('billing tx rollback');

      const orders = await ctx.dataSource.getRepository(Order).find();
      expect(orders.map((o) => o.description)).toEqual(['cross-ds-order']);
    });

    it('two simultaneous transactions on different DSes commit independently', async () => {
      const cross = moduleRef.get(CrossDsService);
      await cross.createBoth('order-a', 100);

      const orders = await ctx.dataSource.getRepository(Order).find();
      const invoices = await billingDs.getRepository(Invoice).find();
      expect(orders.map((o) => o.description)).toEqual(['order-a']);
      expect(invoices.map((i) => i.amount)).toEqual([100]);
    });

    it('outer default-DS tx rolling back AFTER inner billing-DS tx committed leaves billing committed (DD-023 has no distributed rollback)', async () => {
      const cross = moduleRef.get(CrossDsService);

      await expect(cross.createBothThenThrow('order-b', 200)).rejects.toThrow(
        'default-side rollback',
      );

      // Default DS rolled back (its tx threw).
      const orders = await ctx.dataSource.getRepository(Order).find();
      expect(orders).toHaveLength(0);

      // Billing DS committed when its inner method returned —
      // its transaction lifecycle is independent. This is
      // exactly the DD-023 contract: distributed transactions
      // are NOT supported. Apps that need cross-DS atomicity
      // route through the outbox.
      const invoices = await billingDs.getRepository(Invoice).find();
      expect(invoices.map((i) => i.amount)).toEqual([200]);
    });
  });

  describe('REQUIRES_NEW within cross-DS context', () => {
    it('inner REQUIRES_NEW on billing DS rolls back independently of outer default-DS commit', async () => {
      const cross = moduleRef.get(CrossDsService);
      const manager = moduleRef.get(TransactionManager);

      // Roll-your-own composition: outer default tx, inner
      // billing tx with REQUIRES_NEW. Inner throws → billing
      // rolls back. Outer continues, its commit persists the
      // order on default DS.
      const result = await manager.run({ dataSource: 'default' }, async () => {
        await cross.orderRepo.save({ description: 'outer-d' });
        try {
          await manager.run(
            { dataSource: 'billing', propagation: PropagationMode.REQUIRES_NEW },
            async () => {
              await cross.invoiceRepo.save({ amount: 999 });
              throw new Error('billing inner rollback');
            },
          );
        } catch {
          // Inner rolled back — outer continues.
        }
        return 'outer-committed';
      });

      expect(result).toBe('outer-committed');
      const orders = await ctx.dataSource.getRepository(Order).find();
      const invoices = await billingDs.getRepository(Invoice).find();
      expect(orders.map((o) => o.description)).toEqual(['outer-d']);
      expect(invoices).toHaveLength(0);
    });
  });
});
