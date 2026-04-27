import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionManager,
  TransactionalModule,
  Transactional,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import { OutboxEventPublisher } from '../dispatcher/outbox-event-publisher';
import { OutboxListenerRegistry } from '../registry/listener-registry';
import { composeListenerId } from '../registry/outbox-listener-scanner';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import {
  getEventPublicationProcessorToken,
  getEventPublicationRepositoryToken,
  getEventTypeRegistryToken,
  getOutboxListenerRegistryToken,
  getOutboxPublisherToken,
} from '../tokens/token-utils';

import { OutboxModule } from './outbox.module';

/**
 * Per-dataSource fake adapter — `dataSourceName` is set per instance
 * so each adapter participates in its own AsyncLocalStorage entry
 * (DD-023). Unlike the default-named-only adapter used in the
 * single-DS spec, this version takes the name in the constructor.
 */
class NamedFakeAdapter implements TransactionAdapter<TransactionHandle & { id: string; adapterName: string }> {
  readonly name = 'in-memory';
  constructor(readonly dataSourceName: string) {}

  async runInTransaction<T>(
    _options: TransactionOptions,
    fn: (handle: TransactionHandle & { id: string; adapterName: string }) => Promise<T>,
  ): Promise<T> {
    return fn({ id: randomUUID(), adapterName: this.name });
  }

  async runInSavepoint<T>(
    parent: TransactionHandle & { id: string; adapterName: string },
    fn: (handle: TransactionHandle & { id: string; adapterName: string }) => Promise<T>,
  ): Promise<T> {
    return fn(parent);
  }
}

class DefaultEvent {
  constructor(readonly id: string) {}
}

class BillingEvent {
  constructor(readonly invoiceId: string) {}
}

class InventoryEvent {
  constructor(readonly sku: string) {}
}

@Injectable()
class DefaultService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional()
  async produce(id: string): Promise<void> {
    await this.publisher.publish(new DefaultEvent(id));
  }
}

@Injectable()
class BillingService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional({ dataSource: 'billing' })
  async produce(invoiceId: string): Promise<void> {
    await this.publisher.publish(new BillingEvent(invoiceId));
  }
}

@Injectable()
class InventoryService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional({ dataSource: 'inventory' })
  async produce(sku: string): Promise<void> {
    await this.publisher.publish(new InventoryEvent(sku));
  }
}

describe('OutboxModule multi-forRoot (integration, in-memory)', () => {
  let module: TestingModule;
  let defaultService: DefaultService;
  let billingService: BillingService;
  let inventoryService: InventoryService;

  const defaultReceived: DefaultEvent[] = [];
  const billingReceived: BillingEvent[] = [];
  const inventoryReceived: InventoryEvent[] = [];

  beforeEach(async () => {
    OutboxModule.resetForTesting();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    defaultReceived.length = 0;
    billingReceived.length = 0;
    inventoryReceived.length = 0;

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: true,
          adapters: [
            {
              adapterName: 'in-memory',
              instanceName: 'default',
              adapter: new NamedFakeAdapter('default'),
            },
            {
              adapterName: 'in-memory',
              instanceName: 'billing',
              adapter: new NamedFakeAdapter('billing'),
            },
            {
              adapterName: 'in-memory',
              instanceName: 'inventory',
              adapter: new NamedFakeAdapter('inventory'),
            },
          ],
        }),

        // Three separate forRoot calls — one per dataSource.
        OutboxModule.forRoot({}),
        OutboxModule.forRoot({ dataSource: 'billing' }),
        OutboxModule.forRoot({ dataSource: 'inventory' }),

        // Per-DS event-class registrations.
        OutboxModule.forFeature([DefaultEvent], { dataSource: 'default' }),
        OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),
        OutboxModule.forFeature([InventoryEvent], { dataSource: 'inventory' }),
      ],
      providers: [DefaultService, BillingService, InventoryService],
    }).compile();
    await module.init();

    defaultService = module.get(DefaultService);
    billingService = module.get(BillingService);
    inventoryService = module.get(InventoryService);

    // Manual per-DS listener registration (Phase 14.3.1 will fix the
    // scanner to do this automatically based on event ownership).
    const defaultRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('default'),
    );
    defaultRegistry.register({
      id: composeListenerId('DefaultListener', DefaultEvent),
      eventType: DefaultEvent.name,
      invoke: async (event) => {
        defaultReceived.push(event as DefaultEvent);
      },
    });

    const billingRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('billing'),
    );
    billingRegistry.register({
      id: composeListenerId('BillingListener', BillingEvent),
      eventType: BillingEvent.name,
      invoke: async (event) => {
        billingReceived.push(event as BillingEvent);
      },
    });

    const inventoryRegistry = module.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken('inventory'),
    );
    inventoryRegistry.register({
      id: composeListenerId('InventoryListener', InventoryEvent),
      eventType: InventoryEvent.name,
      invoke: async (event) => {
        inventoryReceived.push(event as InventoryEvent);
      },
    });
  });

  afterEach(async () => {
    await module?.close();
  });

  it('boots cleanly with three forRoot calls — facade sees all three dataSources', () => {
    const facade = module.get(OutboxEventPublisher);
    expect([...facade.getRegisteredDataSources()].sort()).toEqual([
      'billing',
      'default',
      'inventory',
    ]);
  });

  it('per-DS repositories are separate InMemoryEventPublicationRepository instances', () => {
    const defaultRepo = module.get<InMemoryEventPublicationRepository>(
      getEventPublicationRepositoryToken('default'),
    );
    const billingRepo = module.get<InMemoryEventPublicationRepository>(
      getEventPublicationRepositoryToken('billing'),
    );
    const inventoryRepo = module.get<InMemoryEventPublicationRepository>(
      getEventPublicationRepositoryToken('inventory'),
    );

    expect(defaultRepo).toBeInstanceOf(InMemoryEventPublicationRepository);
    expect(billingRepo).toBeInstanceOf(InMemoryEventPublicationRepository);
    expect(inventoryRepo).toBeInstanceOf(InMemoryEventPublicationRepository);
    expect(defaultRepo).not.toBe(billingRepo);
    expect(billingRepo).not.toBe(inventoryRepo);
    expect(defaultRepo).not.toBe(inventoryRepo);
  });

  it('routing — default-DS event lands only in default-DS repository', async () => {
    await defaultService.produce('evt-1');

    expect(repoCount(module, 'default')).toBe(1);
    expect(repoCount(module, 'billing')).toBe(0);
    expect(repoCount(module, 'inventory')).toBe(0);
  });

  it('routing — billing-DS event lands only in billing-DS repository', async () => {
    await billingService.produce('inv-42');

    expect(repoCount(module, 'default')).toBe(0);
    expect(repoCount(module, 'billing')).toBe(1);
    expect(repoCount(module, 'inventory')).toBe(0);
  });

  it('routing — inventory-DS event lands only in inventory-DS repository', async () => {
    await inventoryService.produce('SKU-7');

    expect(repoCount(module, 'default')).toBe(0);
    expect(repoCount(module, 'billing')).toBe(0);
    expect(repoCount(module, 'inventory')).toBe(1);
  });

  it('per-DS processors deliver only to their own dataSource', async () => {
    await defaultService.produce('evt-2');
    await billingService.produce('inv-43');
    await inventoryService.produce('SKU-8');

    const defaultProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('default'),
    );
    const billingProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('billing'),
    );
    const inventoryProcessor = module.get<EventPublicationProcessor>(
      getEventPublicationProcessorToken('inventory'),
    );

    await defaultProcessor.processBatch();
    expect(defaultReceived.map((e) => e.id)).toEqual(['evt-2']);
    expect(billingReceived).toHaveLength(0);
    expect(inventoryReceived).toHaveLength(0);

    await billingProcessor.processBatch();
    expect(billingReceived.map((e) => e.invoiceId)).toEqual(['inv-43']);
    expect(inventoryReceived).toHaveLength(0);

    await inventoryProcessor.processBatch();
    expect(inventoryReceived.map((e) => e.sku)).toEqual(['SKU-8']);
  });

  it('cross-DS rollback isolation — billing rollback leaves default DS row committed', async () => {
    const txManager = module.get(TransactionManager);

    await defaultService.produce('evt-survives');

    await expect(
      txManager.run({ dataSource: 'billing' }, async () => {
        const billingPublisher = module.get<OutboxEventPublisher>(OutboxEventPublisher);
        await billingPublisher.publish(new BillingEvent('inv-rolls-back'));
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(repoCount(module, 'default')).toBe(1);
    expect(repoCount(module, 'billing')).toBe(0);
  });

  it('explicit { dataSource } override on publish() wins over event-type routing', async () => {
    const facade = module.get(OutboxEventPublisher);
    const txManager = module.get(TransactionManager);

    // Publish a DefaultEvent (registered to 'default' DS) while
    // explicitly targeting the 'billing' DS. The explicit override
    // routes the publication to billing's repository.
    //
    // Note: the publish method requires an active transaction for
    // the resolved dataSource — wrap in a billing transaction.
    await txManager.run({ dataSource: 'billing' }, async () => {
      // No billing-DS listener subscribes to DefaultEvent, so the
      // publish call is a silent no-op (DataSourceOutboxPublisher
      // returns early on zero listeners). To make the row land we
      // register an ad-hoc billing listener for DefaultEvent.
      const billingRegistry = module.get<OutboxListenerRegistry>(
        getOutboxListenerRegistryToken('billing'),
      );
      billingRegistry.register({
        id: 'OverrideTestListener#DefaultEvent',
        eventType: DefaultEvent.name,
        invoke: async () => undefined,
      });

      await facade.publish(new DefaultEvent('overridden'), { dataSource: 'billing' });
    });

    expect(repoCount(module, 'default')).toBe(0);
    expect(repoCount(module, 'billing')).toBe(1);
  });
});

describe('OutboxModule.forRoot — duplicate-dataSource detection', () => {
  beforeEach(() => {
    OutboxModule.resetForTesting();
  });

  it('throws when the same dataSource is registered twice', () => {
    OutboxModule.forRoot({});
    expect(() => OutboxModule.forRoot({})).toThrow(
      "OutboxModule.forRoot('default') called twice",
    );
  });

  it('throws when a non-default dataSource is registered twice', () => {
    OutboxModule.forRoot({ dataSource: 'billing' });
    expect(() => OutboxModule.forRoot({ dataSource: 'billing' })).toThrow(
      "OutboxModule.forRoot('billing') called twice",
    );
  });

  it('forRootAsync also detects duplicates against forRoot', () => {
    OutboxModule.forRoot({ dataSource: 'billing' });
    expect(() =>
      OutboxModule.forRootAsync({
        dataSource: 'billing',
        useFactory: () => ({}),
      }),
    ).toThrow("OutboxModule.forRootAsync('billing') called twice");
  });
});

describe('OutboxModule.forRoot — registration order independence', () => {
  beforeEach(() => {
    OutboxModule.resetForTesting();
  });

  it('default-DS aliases work when default forRoot is registered AFTER a non-default forRoot', async () => {
    const adapter = new NamedFakeAdapter('default');
    const billingAdapter = new NamedFakeAdapter('billing');

    const m = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapters: [
            { adapterName: 'in-memory', instanceName: 'default', adapter },
            {
              adapterName: 'in-memory',
              instanceName: 'billing',
              adapter: billingAdapter,
            },
          ],
        }),
        // billing first — exercises the path where the singletons (facade,
        // bundle, scanner) are registered by a non-default forRoot.
        OutboxModule.forRoot({ dataSource: 'billing' }),
        OutboxModule.forRoot({}),
      ],
    }).compile();
    await m.init();

    try {
      // Default-DS class-token aliases resolve correctly.
      const defaultRepo = m.get<InMemoryEventPublicationRepository>(
        getEventPublicationRepositoryToken('default'),
      );
      const billingRepo = m.get<InMemoryEventPublicationRepository>(
        getEventPublicationRepositoryToken('billing'),
      );
      expect(defaultRepo).not.toBe(billingRepo);

      // Facade sees both dataSources regardless of registration order.
      const facade = m.get(OutboxEventPublisher);
      expect([...facade.getRegisteredDataSources()].sort()).toEqual(['billing', 'default']);

      // Default-DS singleton tokens (e.g. publisher token) resolve.
      expect(m.get(getOutboxPublisherToken('default'))).toBeDefined();
      expect(m.get(getOutboxPublisherToken('billing'))).toBeDefined();
      expect(m.get(getEventTypeRegistryToken('default'))).toBeDefined();
      expect(m.get(getEventTypeRegistryToken('billing'))).toBeDefined();
    } finally {
      await m.close();
    }
  });
});

function repoCount(module: TestingModule, ds: string): number {
  const repo = module.get<InMemoryEventPublicationRepository>(
    getEventPublicationRepositoryToken(ds),
  );
  return repo.count();
}
