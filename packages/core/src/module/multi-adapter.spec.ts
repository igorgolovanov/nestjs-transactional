import { Inject, Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { TransactionContextView } from '../context/transaction-context-view';
import { TransactionContext } from '../context/transaction.context';
import {
  Transactional,
  getTransactionalMetadata,
} from '../decorators/transactional.decorator';
import { ADAPTER_REGISTRY, AdapterRegistry } from '../manager/adapter.registry';
import { TransactionManager } from '../manager/transaction.manager';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';
import {
  getTransactionContextToken,
  getTransactionManagerToken,
  getTransactionalAdapterToken,
} from '../tokens/token-utils';

import { TransactionalModule } from './transactional.module';

/**
 * Phase 14.2 multi-adapter behaviour: token-based DI registration,
 * the `dataSource` option on `manager.run()` (and therefore on
 * `@Transactional`), and the structural guarantee that the
 * dataSource-keyed lookup isolates parallel transactions across
 * dataSources within a single async chain.
 */
describe('Multi-adapter (Phase 14.2)', () => {
  let module: TestingModule;

  afterEach(async () => {
    await module?.close();
  });

  describe('TransactionalModule.forRoot single-adapter sugar', () => {
    it('registers per-dataSource tokens for the supplied adapter', async () => {
      const adapter = new InMemoryTransactionAdapter('billing');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter,
          }),
        ],
      }).compile();
      await module.init();

      expect(module.get(getTransactionalAdapterToken('billing'))).toBe(adapter);
      const view = module.get<TransactionContextView>(getTransactionContextToken('billing'));
      expect(view).toBeInstanceOf(TransactionContextView);
      expect(view.dataSource).toBe('billing');
      expect(module.get(getTransactionManagerToken('billing'))).toBeInstanceOf(TransactionManager);
    });

    it('registers the adapter into AdapterRegistry under (adapter.name, adapter.dataSourceName)', async () => {
      const adapter = new InMemoryTransactionAdapter('audit');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter,
          }),
        ],
      }).compile();
      await module.init();

      const registry = module.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.get('in-memory', 'audit')).toBe(adapter);
      expect(registry.getByDataSource('audit')).toBe(adapter);
    });
  });

  describe('manager.run({ dataSource }) routing', () => {
    it('routes the transaction to the adapter registered under the given dataSource', async () => {
      const billing = new InMemoryTransactionAdapter('billing');
      const inventory = new InMemoryTransactionAdapter('inventory');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapters: [
              { adapterName: 'in-memory', instanceName: 'billing', adapter: billing },
              { adapterName: 'in-memory', instanceName: 'inventory', adapter: inventory },
            ],
          }),
        ],
      }).compile();
      await module.init();

      const manager = module.get(TransactionManager);

      await manager.run({ dataSource: 'billing' }, async () => {
        // billing committed exactly one tx; inventory none
      });
      await manager.run({ dataSource: 'inventory' }, async () => {});

      expect(billing.committedTransactions).toHaveLength(1);
      expect(inventory.committedTransactions).toHaveLength(1);
    });

    it('throws when the dataSource name is not registered', async () => {
      const adapter = new InMemoryTransactionAdapter('billing');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter,
          }),
        ],
      }).compile();
      await module.init();

      const manager = module.get(TransactionManager);
      await expect(
        manager.run({ dataSource: 'inventory' }, async () => undefined),
      ).rejects.toThrow();
    });
  });

  describe('@Transactional({ dataSource }) metadata propagation', () => {
    it('attaches `dataSource` to the method-level metadata', () => {
      class Service {
        @Transactional({ dataSource: 'billing' })
        async charge(): Promise<void> {}
      }
      const metadata = getTransactionalMetadata(Service.prototype.charge);
      expect(metadata?.dataSource).toBe('billing');
    });
  });

  describe('cross-dataSource simultaneous within a single async chain (DD-023)', () => {
    /**
     * The user's listed concern test (Phase 14.2 prompt). Verifies the
     * structural guarantee: the dataSource-keyed Map lookup actually
     * isolates parallel transactions across dataSources inside the
     * same async stack. Failure here means the keying does not solve
     * the isolation concern and the design needs revisiting.
     */
    it('keeps parallel transactions for two dataSources isolated and both visible to dataSource-aware lookups', async () => {
      const billing = new InMemoryTransactionAdapter('billing');
      const inventory = new InMemoryTransactionAdapter('inventory');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapters: [
              { adapterName: 'in-memory', instanceName: 'billing', adapter: billing },
              { adapterName: 'in-memory', instanceName: 'inventory', adapter: inventory },
            ],
          }),
        ],
      }).compile();
      await module.init();
      const manager = module.get(TransactionManager);

      const observations: string[] = [];

      await manager.run({ dataSource: 'billing' }, async () => {
        // Inside billing — only billing should be active.
        const billingTx = TransactionContext.getActiveTransactionByDataSource('billing');
        const inventoryTxBeforeInner =
          TransactionContext.getActiveTransactionByDataSource('inventory');
        expect(billingTx).toBeDefined();
        expect(billingTx!.adapterInstanceName).toBe('billing');
        expect(inventoryTxBeforeInner).toBeUndefined();
        observations.push('outer:billing-active,inventory-undefined');

        // Open a nested inventory transaction. Both should be live.
        await manager.run({ dataSource: 'inventory' }, async () => {
          const innerBilling = TransactionContext.getActiveTransactionByDataSource('billing');
          const innerInventory =
            TransactionContext.getActiveTransactionByDataSource('inventory');
          expect(innerBilling).toBe(billingTx);
          expect(innerInventory).toBeDefined();
          expect(innerInventory!.adapterInstanceName).toBe('inventory');
          expect(innerBilling).not.toBe(innerInventory);
          observations.push('inner:both-active');
        });

        // After the nested inventory call returns, billing is still
        // active; inventory has been removed from the Map.
        const billingAfterInner =
          TransactionContext.getActiveTransactionByDataSource('billing');
        const inventoryAfterInner =
          TransactionContext.getActiveTransactionByDataSource('inventory');
        expect(billingAfterInner).toBe(billingTx);
        expect(inventoryAfterInner).toBeUndefined();
        observations.push('outer:billing-still-active,inventory-cleared');
      });

      expect(observations).toEqual([
        'outer:billing-active,inventory-undefined',
        'inner:both-active',
        'outer:billing-still-active,inventory-cleared',
      ]);
      expect(billing.committedTransactions).toHaveLength(1);
      expect(inventory.committedTransactions).toHaveLength(1);
    });
  });

  describe('ALS propagation across await boundaries with mutated Map (DD-023)', () => {
    /**
     * The listed concern: when the active-transactions Map is mutated
     * (set / remove) and execution crosses an await, the mutation
     * must remain visible on the same async chain. ALS guarantees
     * this — the Map reference lives in the per-scope store and is
     * shared across all async descendants. This test pins that
     * behaviour against accidental regressions.
     */
    it('preserves Map mutations across await boundaries', async () => {
      const billing = new InMemoryTransactionAdapter('billing');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter: billing,
          }),
        ],
      }).compile();
      await module.init();
      const manager = module.get(TransactionManager);

      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      await manager.run({ dataSource: 'billing' }, async () => {
        const before = TransactionContext.getActiveTransactionByDataSource('billing');
        expect(before).toBeDefined();

        await sleep(5);

        const afterFirstAwait = TransactionContext.getActiveTransactionByDataSource('billing');
        expect(afterFirstAwait).toBe(before);

        await Promise.all([sleep(3), sleep(1), sleep(2)]);

        const afterParallelAwaits =
          TransactionContext.getActiveTransactionByDataSource('billing');
        expect(afterParallelAwaits).toBe(before);
      });

      // After run() returns, the Map entry is gone — same chain, no leak.
      expect(TransactionContext.getActiveTransactionByDataSource('billing')).toBeUndefined();
    });
  });

  describe('per-dataSource @InjectTransactionContext via DI tokens', () => {
    it('resolves a TransactionContextView pre-bound to the requested dataSource', async () => {
      const adapter = new InMemoryTransactionAdapter('billing');

      @Injectable()
      class BillingService {
        constructor(
          @Inject(getTransactionContextToken('billing'))
          readonly view: TransactionContextView,
        ) {}
      }

      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            isGlobal: true,
            registerInterceptor: false,
            registerMethodsBootstrap: false,
            adapter,
          }),
        ],
        providers: [BillingService],
      }).compile();
      await module.init();

      const service = module.get(BillingService);
      expect(service.view.dataSource).toBe('billing');
      expect(service.view.hasActiveTransaction()).toBe(false);

      const manager = module.get(TransactionManager);
      await manager.run({ dataSource: 'billing' }, async () => {
        expect(service.view.hasActiveTransaction()).toBe(true);
        expect(service.view.getActiveTransaction()?.adapterInstanceName).toBe('billing');
      });

      expect(service.view.hasActiveTransaction()).toBe(false);
    });
  });
});
