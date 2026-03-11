import { randomUUID } from 'node:crypto';

import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { EventTypeRegistry } from '../serialization/event-type-registry';
import { JsonEventSerializer } from '../serialization/json-event-serializer';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { CompletionMode } from '../types/completion-mode';
import { PublicationStatus } from '../types/publication-status';

import { EventPublicationRegistry } from './event-publication-registry';

// Inline fake adapter — cqrs specs use the same pattern, because the
// `@nestjs-transactional/core/testing` subpath cannot be resolved under
// the monorepo's `moduleResolution: "node"` setting.
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

describe('EventPublicationRegistry', () => {
  let adapter: FakeAdapter;
  let adapterRegistry: AdapterRegistry;
  let manager: TransactionManager;
  let repo: InMemoryEventPublicationRepository;
  let eventTypes: EventTypeRegistry;
  let serializer: JsonEventSerializer;
  let registry: EventPublicationRegistry;

  beforeEach(() => {
    adapter = new FakeAdapter();
    adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    manager = new TransactionManager(adapterRegistry);
    repo = new InMemoryEventPublicationRepository(manager);
    eventTypes = new EventTypeRegistry();
    serializer = new JsonEventSerializer(eventTypes);
    registry = new EventPublicationRegistry(repo, serializer);
  });

  describe('publish', () => {
    it('persists an entry that survives transaction commit', async () => {
      await manager.run({}, async () => {
        await registry.publish(new OrderPlacedEvent('order-1'), [
          'Inventory.on(OrderPlacedEvent)',
        ]);
      });

      expect(repo.count()).toBe(1);
      expect(repo.getAll()[0]!.listenerId).toBe('Inventory.on(OrderPlacedEvent)');
    });

    it('persists no entries when the transaction rolls back', async () => {
      await expect(
        manager.run({}, async () => {
          await registry.publish(new OrderPlacedEvent('order-1'), [
            'Inventory.on(OrderPlacedEvent)',
          ]);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      expect(repo.count()).toBe(0);
    });

    it('creates one entry per listener id in a single call', async () => {
      await manager.run({}, async () => {
        await registry.publish(new OrderPlacedEvent('order-1'), [
          'Inventory.on(OrderPlacedEvent)',
          'Notification.on(OrderPlacedEvent)',
          'Analytics.on(OrderPlacedEvent)',
        ]);
      });

      expect(repo.count()).toBe(3);
      expect(repo.getAll().map((p) => p.listenerId).sort()).toEqual([
        'Analytics.on(OrderPlacedEvent)',
        'Inventory.on(OrderPlacedEvent)',
        'Notification.on(OrderPlacedEvent)',
      ]);
    });

    it('records eventType as the event class name', async () => {
      await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      expect(repo.getAll()[0]!.eventType).toBe('OrderPlacedEvent');
    });

    it('returns an empty array and skips the repository for no listeners', async () => {
      const repoSpy = jest.spyOn(repo, 'createAll');

      const result = await registry.publish(new OrderPlacedEvent('x'), []);

      expect(result).toEqual([]);
      expect(repoSpy).not.toHaveBeenCalled();
    });
  });

  describe('tryClaim', () => {
    it('claims a PUBLISHED publication and transitions it to PROCESSING', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      const claimed = await registry.tryClaim(created!.id);

      expect(claimed).toBe(true);
      expect((await repo.findById(created!.id))!.status).toBe(PublicationStatus.PROCESSING);
    });

    it('refuses a second claim (idempotent)', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.tryClaim(created!.id);
      const second = await registry.tryClaim(created!.id);

      expect(second).toBe(false);
    });
  });

  describe('markCompleted', () => {
    it('UPDATE mode sets status COMPLETED and stamps completionDate', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.markCompleted(created!.id, CompletionMode.UPDATE);

      const updated = (await repo.findById(created!.id))!;
      expect(updated.status).toBe(PublicationStatus.COMPLETED);
      expect(updated.completionDate).toBeInstanceOf(Date);
    });

    it('defaults to UPDATE mode when no mode is supplied', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.markCompleted(created!.id);

      expect((await repo.findById(created!.id))!.status).toBe(PublicationStatus.COMPLETED);
    });

    it('DELETE mode removes the record outright', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.markCompleted(created!.id, CompletionMode.DELETE);

      expect(await repo.findById(created!.id)).toBeNull();
    });

    it('ARCHIVE mode removes the record from the hot queue', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.markCompleted(created!.id, CompletionMode.ARCHIVE);

      expect(await repo.findById(created!.id)).toBeNull();
    });
  });

  describe('markFailed', () => {
    it('sets status FAILED and stores the failure reason', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.markFailed(created!.id, 'Downstream DB unreachable');

      const updated = (await repo.findById(created!.id))!;
      expect(updated.status).toBe(PublicationStatus.FAILED);
      expect(updated.failureReason).toBe('Downstream DB unreachable');
    });
  });

  describe('markResubmitted', () => {
    it('sets status RESUBMITTED and stamps lastResubmissionDate', async () => {
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener']),
      );

      await registry.markResubmitted(created!.id);

      const updated = (await repo.findById(created!.id))!;
      expect(updated.status).toBe(PublicationStatus.RESUBMITTED);
      expect(updated.lastResubmissionDate).toBeInstanceOf(Date);
    });
  });

  describe('deserialize', () => {
    it('returns an instance of the registered event class with its data', async () => {
      eventTypes.register(OrderPlacedEvent);
      const [created] = await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('order-xyz'), ['listener']),
      );

      const decoded = registry.deserialize(created!);

      expect(decoded).toBeInstanceOf(OrderPlacedEvent);
      expect((decoded as OrderPlacedEvent).orderId).toBe('order-xyz');
    });
  });

  describe('findReadyForProcessing', () => {
    it('returns publications awaiting processing', async () => {
      await manager.run({}, () =>
        registry.publish(new OrderPlacedEvent('x'), ['listener-a', 'listener-b']),
      );

      const ready = await registry.findReadyForProcessing(10);

      expect(ready).toHaveLength(2);
    });
  });
});
