import { Inject, Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { TransactionContextView } from '../context/transaction-context-view';
import { TransactionContext } from '../context/transaction.context';
import { ADAPTER_REGISTRY, AdapterRegistry } from '../manager/adapter.registry';
import { TransactionManager } from '../manager/transaction.manager';
import type { TransactionObserver } from '../observability/transaction-observer';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';
import {
  getTransactionContextToken,
  getTransactionManagerToken,
  getTransactionalAdapterToken,
} from '../tokens/token-utils';

import { TransactionalModule } from './transactional.module';

/**
 * Phase 14.10 multi-`forRoot` coordination behaviour. Static class
 * storage + first-call-special pattern (mirrors `OutboxModule` per
 * ADR-019). Covers the Q5 invariants surfaced in the audit and the
 * concern tests requested in the implementation prompt.
 */
describe('TransactionalModule multi-`forRoot` (Phase 14.10)', () => {
  let module: TestingModule | undefined;

  beforeEach(() => {
    TransactionalModule.resetForTesting();
  });

  afterEach(async () => {
    if (module !== undefined) {
      await module.close();
      module = undefined;
    }
  });

  describe('Q5 invariants', () => {
    it('two `forRoot({ adapter })` with different dataSources both register', async () => {
      const billing = new InMemoryTransactionAdapter('billing');
      const inventory = new InMemoryTransactionAdapter('inventory');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ adapter: billing }),
          TransactionalModule.forRoot({ adapter: inventory }),
        ],
      }).compile();
      await module.init();

      const registry = module.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.get('in-memory', 'billing')).toBe(billing);
      expect(registry.get('in-memory', 'inventory')).toBe(inventory);
      expect(registry.getDefaultInstanceName()).toBe('billing');

      // Per-DS tokens registered for both adapters.
      expect(module.get(getTransactionalAdapterToken('billing'))).toBe(billing);
      expect(module.get(getTransactionalAdapterToken('inventory'))).toBe(inventory);
      const billingView = module.get<TransactionContextView>(
        getTransactionContextToken('billing'),
      );
      expect(billingView.dataSource).toBe('billing');
      expect(module.get(getTransactionManagerToken('billing'))).toBe(
        module.get(TransactionManager),
      );
    });

    it('two `forRoot({ adapter })` with the SAME dataSource throw at module-build time', () => {
      const a = new InMemoryTransactionAdapter('billing');
      const b = new InMemoryTransactionAdapter('billing');
      // The throw fires inside the second `forRoot` call body — i.e.
      // synchronous, before NestJS even sees the imports list.
      expect(() => {
        TransactionalModule.forRoot({ adapter: a });
        TransactionalModule.forRoot({ adapter: b });
      }).toThrow(/dataSource 'billing' already registered/);
    });

    it('infrastructure-only `forRoot({})` then `forRoot({ adapter })` works', async () => {
      const billing = new InMemoryTransactionAdapter('billing');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({}),
          TransactionalModule.forRoot({ adapter: billing }),
        ],
      }).compile();
      await module.init();

      const registry = module.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.get('in-memory', 'billing')).toBe(billing);
      expect(module.get(TransactionManager)).toBeInstanceOf(TransactionManager);
    });

    it('`forRoot({ adapter })` then `forRoot({})` throws (infrastructure already registered)', () => {
      const billing = new InMemoryTransactionAdapter('billing');
      expect(() => {
        TransactionalModule.forRoot({ adapter: billing });
        TransactionalModule.forRoot({});
      }).toThrow(/infrastructure has already been registered/);
    });

    it('two `forRoot({})` calls (both infrastructure-only) — second throws', () => {
      expect(() => {
        TransactionalModule.forRoot({});
        TransactionalModule.forRoot({});
      }).toThrow(/infrastructure has already been registered/);
    });

    it('passing `observers` to a non-first `forRoot` call throws', () => {
      const billing = new InMemoryTransactionAdapter('billing');
      const observer: TransactionObserver = { onTransactionCommit: jest.fn() };
      expect(() => {
        TransactionalModule.forRoot({});
        TransactionalModule.forRoot({ adapter: billing, observers: [observer] });
      }).toThrow(/observers can only be passed in the first forRoot call/);
    });
  });

  describe('singleton coordination — first-call-special', () => {
    it('only the first `forRoot` registers the singleton infrastructure; subsequent calls only contribute per-DS providers', async () => {
      const observer: TransactionObserver = { onTransactionCommit: jest.fn() };
      const billing = new InMemoryTransactionAdapter('billing');
      const inventory = new InMemoryTransactionAdapter('inventory');

      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ adapter: billing, observers: [observer] }),
          TransactionalModule.forRoot({ adapter: inventory }),
        ],
      }).compile();
      await module.init();

      const manager = module.get(TransactionManager);
      // Singleton infrastructure visible across the module — both
      // dataSources route through the same TransactionManager
      // singleton.
      expect(manager).toBeInstanceOf(TransactionManager);
      expect(module.get(getTransactionManagerToken('billing'))).toBe(manager);
      expect(module.get(getTransactionManagerToken('inventory'))).toBe(manager);

      // Observer wired by the first `forRoot` call fires for both
      // dataSources.
      await manager.run({ dataSource: 'billing' }, async () => {});
      await manager.run({ dataSource: 'inventory' }, async () => {});
      expect(observer.onTransactionCommit).toHaveBeenCalledTimes(2);
    });

    it('the AdapterRegistry built by the first call sees every later `forRoot` registration', async () => {
      const a = new InMemoryTransactionAdapter('alpha');
      const b = new InMemoryTransactionAdapter('beta');
      const c = new InMemoryTransactionAdapter('gamma');

      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ adapter: a }),
          TransactionalModule.forRoot({ adapter: b }),
          TransactionalModule.forRoot({ adapter: c }),
        ],
      }).compile();
      await module.init();

      const registry = module.get<AdapterRegistry>(ADAPTER_REGISTRY);
      const all = registry.getAll();
      expect(all.map((r) => r.instanceName).sort()).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  describe('composite key contract preservation (DD-005 / Phase 14.2 B1)', () => {
    /**
     * Concern test — explicitly verifies the multi-`forRoot` rework
     * does not violate the composite key contract that typeorm
     * helpers, cqrs dispatcher, and outbox publisher rely on. The
     * `${adapterName}:${instanceName}` map key inside
     * `TransactionContext` must remain unchanged in shape and
     * lookup behaviour.
     */
    it('TransactionContext lookups by composite key continue to work across two adapters', async () => {
      const billing = new InMemoryTransactionAdapter('billing');
      const inventory = new InMemoryTransactionAdapter('inventory');
      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ adapter: billing }),
          TransactionalModule.forRoot({ adapter: inventory }),
        ],
      }).compile();
      await module.init();
      const manager = module.get(TransactionManager);

      await manager.run({ dataSource: 'billing' }, async () => {
        // The internal Map key is composite — read it through the
        // public dataSource-keyed lookup which follows the same
        // composition rule.
        const billingTx = TransactionContext.getActiveTransactionByDataSource('billing');
        expect(billingTx?.adapterName).toBe('in-memory');
        expect(billingTx?.adapterInstanceName).toBe('billing');

        await manager.run({ dataSource: 'inventory' }, async () => {
          const inventoryTx =
            TransactionContext.getActiveTransactionByDataSource('inventory');
          expect(inventoryTx?.adapterName).toBe('in-memory');
          expect(inventoryTx?.adapterInstanceName).toBe('inventory');
          // Both transactions are concurrently observable — no key
          // collision.
          expect(inventoryTx).not.toBe(billingTx);
        });
      });
    });
  });

  describe('integration — end-to-end multi-`forRoot` boot', () => {
    it('three forRoots wire three independent adapters and the singletons see all of them', async () => {
      const a = new InMemoryTransactionAdapter('alpha');
      const b = new InMemoryTransactionAdapter('beta');
      const c = new InMemoryTransactionAdapter('gamma');

      // Sanity-check: providers consumed from sibling DynamicModules
      // resolve through the global default of `isGlobal: true`
      // (Phase 14.10 default flip).
      @Injectable()
      class CrossDsService {
        constructor(
          @Inject(getTransactionalAdapterToken('alpha'))
          readonly alphaAdapter: InMemoryTransactionAdapter,
          @Inject(getTransactionalAdapterToken('beta'))
          readonly betaAdapter: InMemoryTransactionAdapter,
          @Inject(getTransactionalAdapterToken('gamma'))
          readonly gammaAdapter: InMemoryTransactionAdapter,
          readonly manager: TransactionManager,
        ) {}
      }

      module = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ adapter: a, registerInterceptor: false }),
          TransactionalModule.forRoot({ adapter: b }),
          TransactionalModule.forRoot({ adapter: c }),
        ],
        providers: [CrossDsService],
      }).compile();
      await module.init();

      const service = module.get(CrossDsService);
      expect(service.alphaAdapter).toBe(a);
      expect(service.betaAdapter).toBe(b);
      expect(service.gammaAdapter).toBe(c);
      expect(service.manager).toBeInstanceOf(TransactionManager);

      await service.manager.run({ dataSource: 'alpha' }, async () => undefined);
      await service.manager.run({ dataSource: 'beta' }, async () => undefined);
      await service.manager.run({ dataSource: 'gamma' }, async () => undefined);

      expect(a.committedTransactions).toHaveLength(1);
      expect(b.committedTransactions).toHaveLength(1);
      expect(c.committedTransactions).toHaveLength(1);
    });
  });

  describe('resetForTesting()', () => {
    it('clears the static Map and the infrastructure flag — subsequent `forRoot({})` is treated as first-call-special again', async () => {
      const a = new InMemoryTransactionAdapter('round-1');
      module = await Test.createTestingModule({
        imports: [TransactionalModule.forRoot({ adapter: a })],
      }).compile();
      await module.init();
      expect(module.get(TransactionManager)).toBeInstanceOf(TransactionManager);
      await module.close();
      module = undefined;

      // resetForTesting clears the static state; building a fresh
      // module with another `forRoot` succeeds without throwing
      // 'infrastructure already registered'.
      TransactionalModule.resetForTesting();

      const b = new InMemoryTransactionAdapter('round-2');
      module = await Test.createTestingModule({
        imports: [TransactionalModule.forRoot({ adapter: b })],
      }).compile();
      await module.init();
      expect(module.get(TransactionManager)).toBeInstanceOf(TransactionManager);
      const registry = module.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.getAll().map((r) => r.instanceName)).toEqual(['round-2']);
    });
  });
});
