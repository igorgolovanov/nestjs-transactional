import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { DataSourceOutboxPublisher } from '../dispatcher/data-source-outbox-publisher';
import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import {
  DEFAULT_PROCESSOR_OPTIONS,
  type EventPublicationProcessorOptions,
} from '../dispatcher/processor-options';
import { EventPublicationRegistry } from '../registry/event-publication-registry';
import { OutboxListenerRegistry } from '../registry/listener-registry';
import { EventTypeRegistry } from '../serialization/event-type-registry';
import { JsonEventSerializer } from '../serialization/json-event-serializer';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { CompletionMode } from '../types/completion-mode';
import { PublicationStatus } from '../types/publication-status';

import type { EventExternalizer } from './event-externalizer';
import { ExternalizationRegistry } from './externalization-registry';
import { Externalized } from './externalized.decorator';

interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  readonly dataSourceName = 'default';

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

@Externalized<ExternalizedOrderPlacedEvent>({
  target: 'orders',
  client: 'KAFKA_CLIENT',
  routingKey: (e) => e.tenantId,
  headers: (e) => ({ 'x-tenant': e.tenantId }),
})
class ExternalizedOrderPlacedEvent {
  constructor(readonly orderId: string, readonly tenantId: string) {}
}

@Externalized({ target: 'audit.events', headers: { 'x-source': 'audit-svc' } })
class AuditedEvent {
  constructor(readonly id: string) {}
}

class PlainAuditEvent {
  constructor(readonly id: string) {}
}

describe('EventPublicationProcessor (externalizer wired, no ExternalizationRegistry)', () => {
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let listenerRegistry: OutboxListenerRegistry;
  let publisher: DataSourceOutboxPublisher;
  let processor: EventPublicationProcessor;
  let externalizer: jest.Mocked<EventExternalizer>;

  const options: EventPublicationProcessorOptions = {
    ...DEFAULT_PROCESSOR_OPTIONS,
    pollingInterval: 10_000,
    batchSize: 10,
    maxConcurrent: 4,
    completionMode: CompletionMode.UPDATE,
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const adapter = new FakeAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    manager = new TransactionManager(adapterRegistry);
    repo = new InMemoryEventPublicationRepository(manager);
    const eventTypes = new EventTypeRegistry();
    eventTypes.register(OrderPlacedEvent);
    const publicationRegistry = new EventPublicationRegistry(
      repo,
      new JsonEventSerializer(eventTypes),
    );
    listenerRegistry = new OutboxListenerRegistry();
    publisher = new DataSourceOutboxPublisher(
      'default',
      publicationRegistry,
      listenerRegistry,
    );
    externalizer = { externalize: jest.fn().mockResolvedValue(undefined) };
    processor = new EventPublicationProcessor(
      publicationRegistry,
      listenerRegistry,
      options,
      externalizer,
    );
  });

  afterEach(() => {
    processor.stop();
  });

  it('listener still runs and publication is COMPLETED when an externalizer is bound', async () => {
    const invocations: unknown[] = [];
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async (event) => {
        invocations.push(event);
      },
    });

    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

    await processor.processBatch();

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toBeInstanceOf(OrderPlacedEvent);
    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('does not invoke the externalizer when no ExternalizationRegistry is bound (defensive no-op)', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });

    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

    await processor.processBatch();

    expect(externalizer.externalize).not.toHaveBeenCalled();
  });

  it('does not invoke the externalizer when the listener fails — single-unit atomicity (DD-019)', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {
        throw new Error('downstream unreachable');
      },
    });

    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

    await processor.processBatch();

    expect(externalizer.externalize).not.toHaveBeenCalled();
    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.FAILED);
    expect(pub!.failureReason).toBe('downstream unreachable');
  });

});

describe('EventPublicationProcessor (externalizer + ExternalizationRegistry wired)', () => {
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let listenerRegistry: OutboxListenerRegistry;
  let publisher: DataSourceOutboxPublisher;
  let processor: EventPublicationProcessor;
  let externalizer: jest.Mocked<EventExternalizer>;

  const options: EventPublicationProcessorOptions = {
    ...DEFAULT_PROCESSOR_OPTIONS,
    pollingInterval: 10_000,
    batchSize: 10,
    maxConcurrent: 4,
    completionMode: CompletionMode.UPDATE,
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const adapter = new FakeAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    manager = new TransactionManager(adapterRegistry);
    repo = new InMemoryEventPublicationRepository(manager);

    const eventTypes = new EventTypeRegistry();
    eventTypes.registerAll([ExternalizedOrderPlacedEvent, AuditedEvent, PlainAuditEvent]);
    const externalizationRegistry = new ExternalizationRegistry(eventTypes);
    externalizationRegistry.onModuleInit();

    const publicationRegistry = new EventPublicationRegistry(
      repo,
      new JsonEventSerializer(eventTypes),
    );
    listenerRegistry = new OutboxListenerRegistry();
    publisher = new DataSourceOutboxPublisher(
      'default',
      publicationRegistry,
      listenerRegistry,
    );
    externalizer = { externalize: jest.fn().mockResolvedValue(undefined) };
    processor = new EventPublicationProcessor(
      publicationRegistry,
      listenerRegistry,
      options,
      externalizer,
      externalizationRegistry,
    );
  });

  afterEach(() => {
    processor.stop();
  });

  it('invokes the externalizer with resolved metadata for events carrying @Externalized', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'ExternalizedOrderPlacedEvent',
      invoke: async () => {},
    });

    await manager.run({}, () =>
      publisher.publish(new ExternalizedOrderPlacedEvent('order-1', 'tenant-A')),
    );
    await processor.processBatch();

    expect(externalizer.externalize).toHaveBeenCalledTimes(1);
    const [event, metadata] = externalizer.externalize.mock.calls[0]!;
    expect(event).toBeInstanceOf(ExternalizedOrderPlacedEvent);
    expect(metadata).toEqual({
      eventType: 'ExternalizedOrderPlacedEvent',
      target: 'orders',
      client: 'KAFKA_CLIENT',
      routingKey: 'tenant-A',
      headers: { 'x-tenant': 'tenant-A' },
    });

    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('skips externalization for events without an @Externalized mapping', async () => {
    listenerRegistry.register({
      id: 'Audit.onAudited',
      eventType: 'PlainAuditEvent',
      invoke: async () => {},
    });

    await manager.run({}, () => publisher.publish(new PlainAuditEvent('a-1')));
    await processor.processBatch();

    expect(externalizer.externalize).not.toHaveBeenCalled();
    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('does not invoke the externalizer when the local listener fails (DD-019 atomicity)', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'ExternalizedOrderPlacedEvent',
      invoke: async () => {
        throw new Error('downstream unreachable');
      },
    });

    await manager.run({}, () =>
      publisher.publish(new ExternalizedOrderPlacedEvent('order-1', 'tenant-A')),
    );
    await processor.processBatch();

    expect(externalizer.externalize).not.toHaveBeenCalled();
    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.FAILED);
    expect(pub!.failureReason).toBe('downstream unreachable');
  });

  it('marks the publication FAILED and records ExternalizationError context when the externalizer throws', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'ExternalizedOrderPlacedEvent',
      invoke: async () => {},
    });
    externalizer.externalize.mockRejectedValueOnce(new Error('broker unreachable'));

    await manager.run({}, () =>
      publisher.publish(new ExternalizedOrderPlacedEvent('order-1', 'tenant-A')),
    );
    await processor.processBatch();

    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.FAILED);
    expect(pub!.failureReason).toMatch(/Externalization failed/);
    expect(pub!.failureReason).toMatch(/ExternalizedOrderPlacedEvent/);
    expect(pub!.failureReason).toMatch(/broker unreachable/);
  });

  it('runs the local listener BEFORE the externalizer (success path)', async () => {
    const calls: string[] = [];
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'ExternalizedOrderPlacedEvent',
      invoke: async () => {
        calls.push('listener');
      },
    });
    externalizer.externalize.mockImplementation(async () => {
      calls.push('externalize');
    });

    await manager.run({}, () =>
      publisher.publish(new ExternalizedOrderPlacedEvent('order-1', 'tenant-A')),
    );
    await processor.processBatch();

    expect(calls).toEqual(['listener', 'externalize']);
  });
});

describe('EventPublicationProcessor (without externalizer — backward compatible 3-arg ctor)', () => {
  it('accepts a 3-argument constructor and finalises publications without an externalizer', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const adapter = new FakeAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    const manager = new TransactionManager(adapterRegistry);
    const repo = new InMemoryEventPublicationRepository(manager);
    const eventTypes = new EventTypeRegistry();
    eventTypes.register(OrderPlacedEvent);
    const publicationRegistry = new EventPublicationRegistry(
      repo,
      new JsonEventSerializer(eventTypes),
    );
    const listenerRegistry = new OutboxListenerRegistry();
    const publisher = new DataSourceOutboxPublisher(
      'default',
      publicationRegistry,
      listenerRegistry,
    );

    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });

    // 3-arg form — externalizer omitted entirely.
    const processor = new EventPublicationProcessor(publicationRegistry, listenerRegistry, {
      ...DEFAULT_PROCESSOR_OPTIONS,
      pollingInterval: 10_000,
      batchSize: 10,
      maxConcurrent: 4,
      completionMode: CompletionMode.UPDATE,
    });

    try {
      await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));
      await processor.processBatch();

      const [pub] = repo.getAll();
      expect(pub!.status).toBe(PublicationStatus.COMPLETED);
    } finally {
      processor.stop();
    }
  });
});
