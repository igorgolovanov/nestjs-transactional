import { randomUUID } from 'node:crypto';

import {
  AdapterRegistry,
  IllegalTransactionStateError,
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
import { PublicationStatus } from '../types/publication-status';

import { OutboxEventPublisher } from './outbox-event-publisher';

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

class UnusedEvent {}

describe('OutboxEventPublisher', () => {
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let listenerRegistry: OutboxListenerRegistry;
  let publisher: OutboxEventPublisher;

  beforeEach(() => {
    const adapter = new FakeAdapter();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    manager = new TransactionManager(adapterRegistry);
    repo = new InMemoryEventPublicationRepository(manager);
    const publicationRegistry = new EventPublicationRegistry(
      repo,
      new JsonEventSerializer(new EventTypeRegistry()),
    );
    listenerRegistry = new OutboxListenerRegistry();
    publisher = new OutboxEventPublisher(publicationRegistry, listenerRegistry, manager);
  });

  it('persists a publication per registered listener and the record survives commit', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-1'));
    });

    expect(repo.count()).toBe(1);
    const [publication] = repo.getAll();
    expect(publication!.listenerId).toBe('Inventory.onOrderPlaced');
    expect(publication!.eventType).toBe('OrderPlacedEvent');
    expect(publication!.status).toBe(PublicationStatus.PUBLISHED);
    expect(JSON.parse(publication!.serializedEvent)).toEqual({ orderId: 'order-1' });
  });

  it('creates one publication per listener when multiple listeners are registered', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });
    listenerRegistry.register({
      id: 'Notifications.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-1'));
    });

    expect(repo.count()).toBe(2);
    expect(repo.getAll().map((p) => p.listenerId).sort()).toEqual([
      'Inventory.onOrderPlaced',
      'Notifications.onOrderPlaced',
    ]);
  });

  it('persists no publications when the transaction rolls back', async () => {
    listenerRegistry.register({
      id: 'Inventory.onOrderPlaced',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });

    await expect(
      manager.run({}, async () => {
        await publisher.publish(new OrderPlacedEvent('order-1'));
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(repo.count()).toBe(0);
  });

  it('is a silent no-op when no listeners are registered for the event type', async () => {
    await manager.run({}, async () => {
      await publisher.publish(new UnusedEvent());
    });

    expect(repo.count()).toBe(0);
  });

  it('throws IllegalTransactionStateError when called outside an active transaction', async () => {
    listenerRegistry.register({
      id: 'L',
      eventType: 'OrderPlacedEvent',
      invoke: async () => {},
    });

    await expect(publisher.publish(new OrderPlacedEvent('order-1'))).rejects.toBeInstanceOf(
      IllegalTransactionStateError,
    );
  });

  it('throws even when no listeners are registered — the transaction guard is unconditional', async () => {
    await expect(publisher.publish(new UnusedEvent())).rejects.toBeInstanceOf(
      IllegalTransactionStateError,
    );
  });

  describe('publishAll', () => {
    it('creates publications for every event in the batch', async () => {
      listenerRegistry.register({
        id: 'L',
        eventType: 'OrderPlacedEvent',
        invoke: async () => {},
      });

      await manager.run({}, async () => {
        await publisher.publishAll([
          new OrderPlacedEvent('order-1'),
          new OrderPlacedEvent('order-2'),
          new OrderPlacedEvent('order-3'),
        ]);
      });

      expect(repo.count()).toBe(3);
    });

    it('throws IllegalTransactionStateError on the first event when called outside a transaction', async () => {
      listenerRegistry.register({
        id: 'L',
        eventType: 'OrderPlacedEvent',
        invoke: async () => {},
      });

      await expect(
        publisher.publishAll([new OrderPlacedEvent('order-1'), new OrderPlacedEvent('order-2')]),
      ).rejects.toBeInstanceOf(IllegalTransactionStateError);
    });
  });
});
