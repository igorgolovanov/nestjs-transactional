import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { EventTypeRegistry } from '../serialization/event-type-registry';

import { OutboxModule } from './outbox.module';

interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';

  async runInTransaction<T>(
    _options: TransactionOptions,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    const handle: FakeHandle = { id: randomUUID(), adapterName: this.name };
    return fn(handle);
  }

  async runInSavepoint<T>(
    parent: FakeHandle,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    return fn(parent);
  }
}

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class OrderShippedEvent {
  constructor(readonly orderId: string) {}
}

class InventoryReservedEvent {
  constructor(readonly sku: string) {}
}

function transactionalModule(): ReturnType<typeof TransactionalModule.forRoot> {
  return TransactionalModule.forRoot({
    isGlobal: true,
    registerInterceptor: false,
    registerMethodsBootstrap: false,
    adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter: new FakeAdapter() }],
  });
}

describe('OutboxModule.forFeature', () => {
  let module: TestingModule | undefined;

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  it('registers a single event type', async () => {
    module = await Test.createTestingModule({
      imports: [
        transactionalModule(),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([OrderPlacedEvent]),
      ],
    }).compile();
    await module.init();

    const registry = module.get(EventTypeRegistry);
    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.getAll().size).toBe(1);
  });

  it('registers multiple event types from one forFeature call', async () => {
    module = await Test.createTestingModule({
      imports: [
        transactionalModule(),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([OrderPlacedEvent, OrderShippedEvent]),
      ],
    }).compile();
    await module.init();

    const registry = module.get(EventTypeRegistry);
    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.has('OrderShippedEvent')).toBe(true);
    expect(registry.getAll().size).toBe(2);
  });

  it('accumulates registrations across multiple forFeature calls', async () => {
    module = await Test.createTestingModule({
      imports: [
        transactionalModule(),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([OrderPlacedEvent]),
        OutboxModule.forFeature([OrderShippedEvent, InventoryReservedEvent]),
      ],
    }).compile();
    await module.init();

    const registry = module.get(EventTypeRegistry);
    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.has('OrderShippedEvent')).toBe(true);
    expect(registry.has('InventoryReservedEvent')).toBe(true);
    expect(registry.getAll().size).toBe(3);
  });

  it('treats forFeature([]) as a no-op (no error, no registrations)', async () => {
    module = await Test.createTestingModule({
      imports: [
        transactionalModule(),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([]),
      ],
    }).compile();
    await module.init();

    const registry = module.get(EventTypeRegistry);
    expect(registry.getAll().size).toBe(0);
  });

  it('throws at bootstrap on duplicate event types within a single forFeature call', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          transactionalModule(),
          OutboxModule.forRoot({}),
          OutboxModule.forFeature([OrderPlacedEvent, OrderPlacedEvent]),
        ],
      }).compile(),
    ).rejects.toThrow(/Event type 'OrderPlacedEvent' already registered/);
  });

  it('throws at bootstrap on duplicate event types across multiple forFeature calls', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          transactionalModule(),
          OutboxModule.forRoot({}),
          OutboxModule.forFeature([OrderPlacedEvent]),
          OutboxModule.forFeature([OrderPlacedEvent]),
        ],
      }).compile(),
    ).rejects.toThrow(/Event type 'OrderPlacedEvent' already registered/);
  });

  it('fails clearly when forFeature is used without forRoot (EVENT_TYPE_REGISTRY missing)', async () => {
    await expect(
      Test.createTestingModule({
        imports: [transactionalModule(), OutboxModule.forFeature([OrderPlacedEvent])],
      }).compile(),
    ).rejects.toThrow();
  });

  it('supports the same forFeature DynamicModule reused across feature modules without provider-token collisions', async () => {
    // Each forFeature call generates its own Symbol token. Reusing
    // the SAME DynamicModule reference (e.g. stored in a const and
    // imported by two feature modules) gives NestJS a single provider
    // entry that deduplicates naturally — the factory still runs
    // exactly once and registers each event exactly once.
    const orderFeature = OutboxModule.forFeature([OrderPlacedEvent]);

    @Module({ imports: [orderFeature] })
    class OrdersModule {}

    @Module({ imports: [orderFeature] })
    class ReportingModule {}

    module = await Test.createTestingModule({
      imports: [
        transactionalModule(),
        OutboxModule.forRoot({}),
        OrdersModule,
        ReportingModule,
      ],
    }).compile();
    await module.init();

    const registry = module.get(EventTypeRegistry);
    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.getAll().size).toBe(1);
  });

  it('works when forFeature module is imported BEFORE forRoot in the parent module', async () => {
    // NestJS resolves the full module graph before running factory
    // providers. EVENT_TYPE_REGISTRY is found regardless of import
    // order, as long as it ends up in the same application context.
    @Module({ imports: [OutboxModule.forFeature([OrderPlacedEvent])] })
    class OrdersModule {}

    module = await Test.createTestingModule({
      imports: [
        transactionalModule(),
        OrdersModule, // forFeature first
        OutboxModule.forRoot({}), // forRoot after
      ],
    }).compile();
    await module.init();

    const registry = module.get(EventTypeRegistry);
    expect(registry.has('OrderPlacedEvent')).toBe(true);
  });
});
