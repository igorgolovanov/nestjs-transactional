import { randomUUID } from 'node:crypto';

import { type DynamicModule, Injectable, Logger, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionManager,
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { FailedEventPublications } from '../api/failed-event-publications';
import { OutboxEventsHandler } from '../decorators/outbox-events-handler.decorator';
import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import { OutboxEventPublisher } from '../dispatcher/outbox-event-publisher';
import type { IOutboxEventsHandler } from '../interfaces/outbox-events-handler.interface';
import { OutboxModule } from '../module/outbox.module';
import { EVENT_PUBLICATION_REPOSITORY } from '../repository/event-publication-repository';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { PublicationStatus } from '../types/publication-status';

import { EVENT_EXTERNALIZER, type EventExternalizer } from './event-externalizer';
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

@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  routingKey: (e) => e.tenantId,
  headers: (e) => ({ 'x-tenant': e.tenantId }),
})
class OrderPlacedEvent {
  constructor(readonly orderId: string, readonly tenantId: string) {}
}

class InternalAuditEvent {
  constructor(readonly id: string) {}
}

@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], newTransaction: false })
class OrderPlacedListener implements IOutboxEventsHandler<OrderPlacedEvent> {
  invocations: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.invocations.push(event);
  }
}

@Injectable()
@OutboxEventsHandler({ events: [InternalAuditEvent], newTransaction: false })
class AuditListener implements IOutboxEventsHandler<InternalAuditEvent> {
  invocations: InternalAuditEvent[] = [];

  async handle(event: InternalAuditEvent): Promise<void> {
    this.invocations.push(event);
  }
}

/**
 * Mocks how `OutboxMicroservicesModule` (Phase 11.3) will register
 * the externalizer: as a global module that exports the
 * `EVENT_EXTERNALIZER` binding so the `OutboxModule` factory can
 * resolve it through DI.
 */
@Module({})
class ExternalizerBridgeModule {
  static forValue(externalizer: EventExternalizer): DynamicModule {
    return {
      module: ExternalizerBridgeModule,
      global: true,
      providers: [{ provide: EVENT_EXTERNALIZER, useValue: externalizer }],
      exports: [EVENT_EXTERNALIZER],
    };
  }
}

describe('Externalization end-to-end (OutboxModule + mock externalizer)', () => {
  let module: TestingModule;
  let externalizer: jest.Mocked<EventExternalizer>;

  async function buildModule(): Promise<void> {
    externalizer = { externalize: jest.fn().mockResolvedValue(undefined) };
    const adapter = new FakeAdapter();
    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
        }),
        ExternalizerBridgeModule.forValue(externalizer),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([OrderPlacedEvent, InternalAuditEvent]),
      ],
      providers: [OrderPlacedListener, AuditListener],
    }).compile();
    await module.init();
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await module?.close();
  });

  it('publishes an @Externalized event through both the local listener and the externalizer', async () => {
    await buildModule();
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);
    const listener = module.get(OrderPlacedListener);

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-1', 'tenant-A'));
    });

    await processor.processBatch();

    expect(listener.invocations).toHaveLength(1);
    expect(externalizer.externalize).toHaveBeenCalledTimes(1);
    const [event, metadata] = externalizer.externalize.mock.calls[0]!;
    expect(event).toBeInstanceOf(OrderPlacedEvent);
    expect(metadata).toEqual({
      eventType: 'OrderPlacedEvent',
      target: 'orders.placed',
      client: undefined,
      routingKey: 'tenant-A',
      headers: { 'x-tenant': 'tenant-A' },
    });
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('does not invoke the externalizer for events without an @Externalized mapping', async () => {
    await buildModule();
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const auditListener = module.get(AuditListener);

    await manager.run({}, async () => {
      await publisher.publish(new InternalAuditEvent('a-1'));
    });

    await processor.processBatch();

    expect(auditListener.invocations).toHaveLength(1);
    expect(externalizer.externalize).not.toHaveBeenCalled();
  });

  it('records ExternalizationError context on the publication when the externalizer throws', async () => {
    await buildModule();
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);

    externalizer.externalize.mockRejectedValueOnce(new Error('broker down'));

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-x', 'tenant-X'));
    });

    await processor.processBatch();

    const [pub] = repo.getAll();
    expect(pub!.status).toBe(PublicationStatus.FAILED);
    expect(pub!.failureReason).toMatch(/Externalization failed/);
    expect(pub!.failureReason).toMatch(/broker down/);
  });

  it('FailedEventPublications.resubmit drives an externalizer-failed publication to COMPLETED on retry', async () => {
    await buildModule();
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);
    const failed = module.get(FailedEventPublications);

    externalizer.externalize.mockRejectedValueOnce(new Error('transient broker error'));

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-retry', 'tenant-A'));
    });

    await processor.processBatch();
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.FAILED);

    const resubmitted = await failed.resubmit();
    expect(resubmitted).toBe(1);

    await processor.processBatch();

    expect(externalizer.externalize).toHaveBeenCalledTimes(2);
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('exposes ExternalizationRegistry through DI with the @Externalized event types indexed', async () => {
    await buildModule();
    const registry = module.get(ExternalizationRegistry);

    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.has('InternalAuditEvent')).toBe(false);
  });
});

describe('Externalization end-to-end (OutboxModule without an externalizer)', () => {
  let module: TestingModule;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await module?.close();
  });

  it('runs to COMPLETED for @Externalized events even when no externalizer is bound (DD-018)', async () => {
    const adapter = new FakeAdapter();
    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
        }),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([OrderPlacedEvent]),
      ],
      providers: [OrderPlacedListener],
    }).compile();
    await module.init();

    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);
    const listener = module.get(OrderPlacedListener);

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-1', 'tenant-A'));
    });

    await processor.processBatch();

    expect(listener.invocations).toHaveLength(1);
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.COMPLETED);
  });
});
