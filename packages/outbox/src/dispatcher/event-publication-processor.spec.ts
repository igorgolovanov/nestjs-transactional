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

  async runInSavepoint<T>(parent: FakeHandle, fn: (handle: FakeHandle) => Promise<T>): Promise<T> {
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
  let eventTypeRegistry: EventTypeRegistry;
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
    eventTypeRegistry = new EventTypeRegistry();
    eventTypeRegistry.register(OrderPlacedEvent);
    const publicationRegistry = new EventPublicationRegistry(
      repo,
      new JsonEventSerializer(eventTypeRegistry),
    );
    listenerRegistry = new OutboxListenerRegistry();
    publisher = new DataSourceOutboxPublisher('default', publicationRegistry, listenerRegistry);
    processor = new EventPublicationProcessor(publicationRegistry, listenerRegistry, options);
    invocations = [];
  });

  afterEach(async () => {
    await processor.stop();
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
    jest.spyOn(repo, 'findReadyForProcessing').mockRejectedValueOnce(new Error('DB down'));

    await expect(processor.processBatch()).resolves.toBeUndefined();
  });

  it('start is idempotent — calling twice does not schedule twice', async () => {
    processor.start();
    processor.start();
    // No assertion on the timer internals — this smoke-tests that the
    // second call does not throw and can be stopped cleanly.
    await expect(processor.stop()).resolves.toBeUndefined();
  });

  describe('shutdown drain', () => {
    // `stop()` used to only clear the next-tick timer, leaving a batch
    // dispatched by the previous tick running unsupervised. NestJS then
    // carried on tearing down the DataSource, which could cut a
    // publication's PROCESSING → COMPLETED transition in half and strand
    // the row for the staleness monitor to find later. These specs pin
    // the drain that closes that window.

    /** A promise plus its resolver, so a listener can be held open. */
    function gate() {
      let open!: () => void;
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { held, open };
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Register a listener that blocks on `held` and resolves
     * `invoked` as soon as the processor calls it, so a test can wait
     * for a batch to be genuinely in flight instead of guessing.
     */
    function blockingListener(held: Promise<void>) {
      const entered = gate();
      listenerRegistry.register({
        id: 'Inventory.onOrderPlaced',
        eventType: 'OrderPlacedEvent',
        invoke: async () => {
          entered.open();
          await held;
        },
      });
      return entered.held;
    }

    function drainingProcessor(shutdownTimeout: number): EventPublicationProcessor {
      return new EventPublicationProcessor(
        new EventPublicationRegistry(repo, new JsonEventSerializer(eventTypeRegistry)),
        listenerRegistry,
        { ...options, pollingInterval: 1, shutdownTimeout },
      );
    }

    it('waits for an in-flight batch instead of abandoning it', async () => {
      const listener = gate();
      const invoked = blockingListener(listener.held);
      await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

      const draining = drainingProcessor(5_000);
      draining.start();
      await invoked;

      let settled = false;
      const stopped = draining.stop().then(() => {
        settled = true;
      });

      // The listener is still running, so the drain must still be open.
      await sleep(30);
      expect(settled).toBe(false);

      listener.open();
      await stopped;

      expect(settled).toBe(true);
      // The whole point: the publication reached a terminal state rather
      // than being stranded in PROCESSING.
      expect(repo.getAll()[0]!.status).toBe(PublicationStatus.COMPLETED);
    });

    it('resolves immediately when no batch is in flight', async () => {
      const idle = drainingProcessor(5_000);
      idle.start();

      const start = Date.now();
      await idle.stop();

      expect(Date.now() - start).toBeLessThan(1_000);
    });

    it('gives up after the drain timeout so a stuck listener cannot block shutdown', async () => {
      const listener = gate();
      const invoked = blockingListener(listener.held);
      await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

      const draining = drainingProcessor(25);
      draining.start();
      await invoked;

      const warn = jest.spyOn(Logger.prototype, 'warn');
      await draining.stop();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain timed out'));
      // Still PROCESSING — the operator's trade-off: shutdown proceeds
      // and the staleness monitor recovers the row on the next boot.
      expect(repo.getAll()[0]!.status).toBe(PublicationStatus.PROCESSING);

      listener.open();
    });

    it('does not wait at all when the drain timeout is 0', async () => {
      const listener = gate();
      const invoked = blockingListener(listener.held);
      await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

      const draining = drainingProcessor(0);
      draining.start();
      await invoked;

      const start = Date.now();
      await draining.stop();

      expect(Date.now() - start).toBeLessThan(1_000);
      expect(repo.getAll()[0]!.status).toBe(PublicationStatus.PROCESSING);

      listener.open();
    });

    it('starts no further batch once stopped', async () => {
      const listener = gate();
      const invoked = blockingListener(listener.held);
      await manager.run({}, () => publisher.publish(new OrderPlacedEvent('order-1')));

      const draining = drainingProcessor(5_000);
      draining.start();
      await invoked;
      listener.open();
      await draining.stop();

      const findReady = jest.spyOn(repo, 'findReadyForProcessing');
      await sleep(30);

      expect(findReady).not.toHaveBeenCalled();
    });

    it('is safe to stop twice', async () => {
      const draining = drainingProcessor(5_000);
      draining.start();

      await expect(Promise.all([draining.stop(), draining.stop()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    });
  });
});
