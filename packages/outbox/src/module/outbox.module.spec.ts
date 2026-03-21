import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
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
import type { IOutboxEventHandler } from '../interfaces/outbox-event-handler.interface';
import { StalenessMonitor } from '../recovery/staleness-monitor';
import { EVENT_PUBLICATION_REPOSITORY } from '../repository/event-publication-repository';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { PublicationStatus } from '../types/publication-status';

import { OutboxModule } from './outbox.module';

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

@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], newTransaction: false })
class FlakyListener implements IOutboxEventHandler<OrderPlacedEvent> {
  invocations: OrderPlacedEvent[] = [];
  failuresRemaining = 0;

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.invocations.push(event);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('transient failure');
    }
  }
}

describe('OutboxModule (integration)', () => {
  let module: TestingModule;
  let adapter: FakeAdapter;

  async function buildModule(
    outboxOptions: Parameters<typeof OutboxModule.forRoot>[0] = {},
  ): Promise<void> {
    adapter = new FakeAdapter();
    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapter,
        }),
        OutboxModule.forRoot({
          ...outboxOptions,
        }),
        OutboxModule.forFeature([OrderPlacedEvent]),
      ],
      providers: [FlakyListener],
    }).compile();
    await module.init();
  }

  beforeEach(() => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await module?.close();
  });

  it('wires the full stack: publish → processBatch → listener invoked → publication COMPLETED', async () => {
    await buildModule();
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);
    const listener = module.get(FlakyListener);

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-1'));
    });

    expect(repo.count()).toBe(1);
    expect(listener.invocations).toHaveLength(0);

    await processor.processBatch();

    expect(listener.invocations).toHaveLength(1);
    expect(listener.invocations[0]!.orderId).toBe('order-1');
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('listener exception marks publication FAILED; resubmit via API drives it to COMPLETED', async () => {
    await buildModule();
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);
    const listener = module.get(FlakyListener);
    const failed = module.get(FailedEventPublications);

    listener.failuresRemaining = 1;

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-42'));
    });

    await processor.processBatch();

    expect(listener.invocations).toHaveLength(1);
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.FAILED);
    expect(repo.getAll()[0]!.failureReason).toBe('transient failure');

    const resubmitted = await failed.resubmit();
    expect(resubmitted).toBe(1);
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.RESUBMITTED);

    await processor.processBatch();

    expect(listener.invocations).toHaveLength(2);
    expect(repo.getAll()[0]!.status).toBe(PublicationStatus.COMPLETED);
  });

  it('staleness monitor flips a long-PROCESSING publication to FAILED', async () => {
    await buildModule({
      staleness: { processing: 10, monitorInterval: 60_000 },
    });
    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const repo = module.get<InMemoryEventPublicationRepository>(EVENT_PUBLICATION_REPOSITORY);
    const monitor = module.get(StalenessMonitor);

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('order-stale'));
    });

    // Simulate a worker that crashed mid-flight: manually put the row
    // in PROCESSING with a publicationDate far in the past.
    const [pub] = repo.getAll();
    repo.reset();
    await repo.createAll([
      {
        listenerId: pub!.listenerId,
        eventType: pub!.eventType,
        serializedEvent: pub!.serializedEvent,
        publicationDate: new Date(Date.now() - 120_000),
      },
    ]);
    const [stalePub] = repo.getAll();
    await repo.updateStatus(stalePub!.id, PublicationStatus.PROCESSING);

    await monitor.checkStaleness();

    expect((await repo.findById(stalePub!.id))!.status).toBe(PublicationStatus.FAILED);
  });

  it('forRootAsync wires the same stack from an async factory result', async () => {
    adapter = new FakeAdapter();
    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapter,
        }),
        OutboxModule.forRootAsync({
          useFactory: async () => {
            await Promise.resolve();
            return {};
          },
        }),
        OutboxModule.forFeature([OrderPlacedEvent]),
      ],
      providers: [FlakyListener],
    }).compile();
    await module.init();

    const manager = module.get(TransactionManager);
    const publisher = module.get(OutboxEventPublisher);
    const processor = module.get(EventPublicationProcessor);
    const listener = module.get(FlakyListener);

    await manager.run({}, async () => {
      await publisher.publish(new OrderPlacedEvent('async-order'));
    });
    await processor.processBatch();

    expect(listener.invocations).toHaveLength(1);
  });
});
