import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { EventPublicationRegistry } from '../registry/event-publication-registry';
import { OutboxListenerRegistry } from '../registry/listener-registry';
import { EventTypeRegistry } from '../serialization/event-type-registry';
import { JsonEventSerializer } from '../serialization/json-event-serializer';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { CompletionMode } from '../types/completion-mode';
import { PublicationStatus } from '../types/publication-status';

import { DataSourceOutboxPublisher } from './data-source-outbox-publisher';
import { EventPublicationProcessor } from './event-publication-processor';
import {
  DEFAULT_PROCESSOR_OPTIONS,
  type EventPublicationProcessorOptions,
} from './processor-options';

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

describe('EventPublicationProcessor', () => {
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let listenerRegistry: OutboxListenerRegistry;
  let publisher: DataSourceOutboxPublisher;
  let processor: EventPublicationProcessor;
  let invocations: unknown[];

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
    processor = new EventPublicationProcessor(publicationRegistry, listenerRegistry, options);
    invocations = [];
  });

  afterEach(() => {
    processor.stop();
  });

  it('invokes the listener and marks the publication COMPLETED', async () => {
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
    expect(pub!.completionDate).toBeInstanceOf(Date);
  });

  it('marks the publication FAILED with a reason when the listener throws', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {
        throw new Error('downstream unreachable');
      },
    });

    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

    await processor.processBatch();

    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.FAILED);
    expect(pub!.failureReason).toBe('downstream unreachable');
    expect(pub!.completionAttempts).toBe(1);
  });

  it('marks the publication FAILED when the listener id is no longer registered', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });
    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

    // Simulate the code being deployed with the listener renamed / removed.
    listenerRegistry.clear();

    await processor.processBatch();

    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.FAILED);
    expect(pub!.failureReason).toMatch(/not registered/);
  });

  it('is a no-op when there are no pending publications', async () => {
    await expect(processor.processBatch()).resolves.toBeUndefined();
  });

  it('prevents double processing when two workers race', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async (event) => {
        invocations.push(event);
      },
    });

    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

    await Promise.all([processor.processBatch(), processor.processBatch()]);

    expect(invocations).toHaveLength(1);
    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('processes every publication in a batch even when they span multiple concurrency chunks', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async (event) => {
        invocations.push(event);
      },
    });

    await manager.run({}, async () => {
      for (let i = 0; i < 10; i++) {
        await publisher.publish(new OrderPlacedEvent(`order-${i}`));
      }
    });

    expect(repo.count()).toBe(10);

    await processor.processBatch();

    expect(invocations).toHaveLength(10);
    expect(repo.getAll().every((p) => p.status === PublicationStatus.COMPLETED)).toBe(true);
  });

  it('swallows infrastructure errors from findReadyForProcessing without throwing', async () => {
    jest
      .spyOn(repo, 'findReadyForProcessing')
      .mockRejectedValueOnce(new Error('DB down'));

    await expect(processor.processBatch()).resolves.toBeUndefined();
  });

  it('start is idempotent — calling twice does not schedule twice', () => {
    processor.start();
    processor.start();
    // No assertion on the timer internals — this smoke-tests that the
    // second call does not throw and can be stopped cleanly.
    expect(() => processor.stop()).not.toThrow();
  });
});
