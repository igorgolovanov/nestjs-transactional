import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  AdapterRegistry,
  IllegalTransactionStateError,
  PropagationMode,
  TransactionContext,
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

import { DataSourceOutboxPublisher } from './data-source-outbox-publisher';

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

class UnusedEvent {}

describe('DataSourceOutboxPublisher', () => {
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let listenerRegistry: OutboxListenerRegistry;
  let publisher: DataSourceOutboxPublisher;

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
    publisher = new DataSourceOutboxPublisher(
      'default',
      publicationRegistry,
      listenerRegistry,
    );
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

  describe('scheduleForPublication', () => {
    beforeEach(() => {
      listenerRegistry.register({
        id: 'Inventory.onOrderPlaced',
        eventType: 'OrderPlacedEvent',
        invoke: async () => {},
      });
    });

    it('buffers events inside a transaction and flushes them via a single beforeCommit hook', async () => {
      // Phase 14.3: the per-DS publisher pushes the hook directly
      // onto `tx.beforeCommitHooks` (not via
      // `manager.registerBeforeCommit`, which targets only the
      // first-active transaction — wrong in multi-DS scenarios).
      // Verify by counting hooks attached to the active transaction.
      let attachedHookCount = -1;

      await manager.run({}, async () => {
        publisher.scheduleForPublication(new OrderPlacedEvent('order-1'));
        publisher.scheduleForPublication(new OrderPlacedEvent('order-2'));
        publisher.scheduleForPublication(new OrderPlacedEvent('order-3'));

        // Not yet flushed — the beforeCommit hook has not fired.
        expect(repo.count()).toBe(0);

        // Capture how many hooks the publisher attached. Single
        // hook regardless of how many events were scheduled.
        const store = TransactionContext.getStore()!;
        const tx = Array.from(store.activeTransactions.values())[0]!;
        attachedHookCount = tx.beforeCommitHooks.length;
      });

      // After commit the hook has flushed the buffer.
      expect(repo.count()).toBe(3);
      expect(repo.getAll().map((p) => JSON.parse(p.serializedEvent).orderId)).toEqual([
        'order-1',
        'order-2',
        'order-3',
      ]);

      // One hook per transaction, not one per event.
      expect(attachedHookCount).toBe(1);
    });

    it('flushes nothing when the transaction rolls back', async () => {
      await expect(
        manager.run({}, async () => {
          publisher.scheduleForPublication(new OrderPlacedEvent('order-a'));
          publisher.scheduleForPublication(new OrderPlacedEvent('order-b'));
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      expect(repo.count()).toBe(0);
    });

    it('keeps per-transaction buffers isolated — nested REQUIRES_NEW flushes independently', async () => {
      // Outer publishes one event, then opens a REQUIRES_NEW inner that
      // publishes a second. The inner must flush on its own commit
      // without dragging the outer event along.
      let innerFlushCount = -1;
      await manager.run({}, async () => {
        publisher.scheduleForPublication(new OrderPlacedEvent('outer'));

        await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
          publisher.scheduleForPublication(new OrderPlacedEvent('inner'));
          // Inside the inner tx, nothing has been flushed yet.
          expect(repo.count()).toBe(0);
        });

        innerFlushCount = repo.count();
      });

      // After the inner commits, its event is persisted. The outer's
      // event is still buffered until the outer commits.
      expect(innerFlushCount).toBe(1);
      expect(repo.count()).toBe(2);
      const listenerIds = repo.getAll().map((p) => JSON.parse(p.serializedEvent).orderId);
      expect(listenerIds).toContain('outer');
      expect(listenerIds).toContain('inner');
    });

    it('outside a transaction falls back to fire-and-forget publish and logs the failure', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      // publish() throws synchronously-ish (rejects) outside a tx;
      // scheduleForPublication catches and logs. We assert the
      // rejection was swallowed by awaiting a microtask flush.
      publisher.scheduleForPublication(new OrderPlacedEvent('nowhere'));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      // Phase 14.3: error message names the dataSource explicitly.
      expect(errorSpy.mock.calls[0]![0]).toContain(
        "scheduleForPublication outside an active 'default' transaction",
      );
      expect(repo.count()).toBe(0);
    });
  });
});
