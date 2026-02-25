import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import { OutboxEventPublisher } from '../dispatcher/outbox-event-publisher';
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

describe('EventPublicationProcessor (with externalizer wired)', () => {
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let listenerRegistry: OutboxListenerRegistry;
  let publisher: OutboxEventPublisher;
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
    publisher = new OutboxEventPublisher(publicationRegistry, listenerRegistry, manager);
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

  it('does not invoke the externalizer in Phase 11.1 — ExternalizationRegistry resolution lands in 11.2', async () => {
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

  it('keeps the listener-then-externalize call order intact (verified via the FAILED-listener path)', async () => {
    // The Phase 11.1 stub never calls the externalizer, so we cannot
    // observe ordering from a successful path yet. The negative case
    // — listener throws BEFORE we ever reach `tryExternalize` — pins
    // the contract that externalization is gated on listener success.
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {
        throw new Error('boom');
      },
    });

    await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));
    await processor.processBatch();

    expect(externalizer.externalize).not.toHaveBeenCalled();
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
    const publisher = new OutboxEventPublisher(publicationRegistry, listenerRegistry, manager);

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
