import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import {
  FailedEventPublications,
  OutboxEventListener,
  OutboxEventPublisher,
  OutboxModule,
  type OutboxModuleOptions,
  EventPublicationProcessor,
  PublicationStatus,
} from '@nestjs-transactional/outbox-core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { EventPublicationArchiveEntity } from '../../src/entity/event-publication-archive.entity';
import { EventPublicationEntity } from '../../src/entity/event-publication.entity';
import {
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '../../src/module/outbox-typeorm.module';
import {
  type PostgresTestContext,
  startPostgresContainer,
  stopPostgresContainer,
} from '../setup-testcontainers';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

@Injectable()
class OrderListener {
  received: OrderPlacedEvent[] = [];
  failuresRemaining = 0;

  @OutboxEventListener(OrderPlacedEvent, { newTransaction: false })
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('simulated listener failure');
    }
    this.received.push(event);
  }
}

@Injectable()
class PlaceOrderService {
  constructor(private readonly publisher: OutboxEventPublisher) {}

  @Transactional()
  async place(orderId: string): Promise<void> {
    await this.publisher.publish(new OrderPlacedEvent(orderId));
  }
}

describe('OutboxTypeOrmModule (full-stack integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;

  async function buildApp(
    outboxOverrides: Partial<OutboxModuleOptions> = {},
  ): Promise<TestingModule> {
    const app = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          // Interceptor would need an HTTP adapter; skip for a plain
          // test harness. The methods bootstrap is what wraps
          // @Transactional on provider methods.
          registerInterceptor: false,
          registerMethodsBootstrap: true,
        }),
        TypeOrmTransactionalModule.forFeature({
          dataSource: ctx.dataSource,
          instanceName: 'default',
          isDefault: true,
        }),
        OutboxTypeOrmModule.forFeature({
          dataSource: ctx.dataSource,
        }),
        OutboxModule.forRoot({
          eventTypes: [OrderPlacedEvent],
          repository: typeOrmEventPublicationRepositoryProvider,
          ...outboxOverrides,
        }),
      ],
      providers: [OrderListener, PlaceOrderService],
    }).compile();
    await app.init();
    return app;
  }

  beforeAll(async () => {
    ctx = await startPostgresContainer({
      entities: [EventPublicationEntity, EventPublicationArchiveEntity],
      synchronize: true,
    });
  });

  afterAll(async () => {
    await stopPostgresContainer(ctx);
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await ctx.dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await ctx.dataSource.getRepository(EventPublicationEntity).clear();
  });

  it('publishes event inside @Transactional → row committed as PUBLISHED → processor delivers → row becomes COMPLETED', async () => {
    const app = await buildApp();
    try {
      const service = app.get(PlaceOrderService);
      const listener = app.get(OrderListener);
      const processor = app.get(EventPublicationProcessor);

      await service.place('order-1');

      const afterCommit = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      expect(afterCommit).toHaveLength(1);
      expect(afterCommit[0]!.status).toBe(PublicationStatus.PUBLISHED);
      expect(listener.received).toHaveLength(0);

      await processor.processBatch();

      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]!.orderId).toBe('order-1');

      const afterProcess = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: afterCommit[0]!.id } });
      expect(afterProcess.status).toBe(PublicationStatus.COMPLETED);
      expect(afterProcess.completionDate).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('listener throws → row becomes FAILED → FailedEventPublications.resubmit() → re-processed to COMPLETED', async () => {
    const app = await buildApp();
    try {
      const service = app.get(PlaceOrderService);
      const listener = app.get(OrderListener);
      const processor = app.get(EventPublicationProcessor);
      const failedApi = app.get(FailedEventPublications);

      listener.failuresRemaining = 1;

      await service.place('order-42');
      await processor.processBatch();

      const failedRow = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: {} });
      expect(failedRow.status).toBe(PublicationStatus.FAILED);
      expect(failedRow.failureReason).toBe('simulated listener failure');
      expect(failedRow.completionAttempts).toBe(1);
      expect(listener.received).toHaveLength(0);

      const resubmitted = await failedApi.resubmit();
      expect(resubmitted).toBe(1);

      const resubmittedRow = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: failedRow.id } });
      expect(resubmittedRow.status).toBe(PublicationStatus.RESUBMITTED);
      expect(resubmittedRow.lastResubmissionDate).not.toBeNull();

      await processor.processBatch();

      expect(listener.received).toHaveLength(1);
      const finalRow = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: failedRow.id } });
      expect(finalRow.status).toBe(PublicationStatus.COMPLETED);
      expect(finalRow.completionAttempts).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('simulated crash: unacknowledged PUBLISHED rows survive across process restart; republishOnStartup resubmits them', async () => {
    // First app — publishes one event and then "crashes" (closes)
    // before the processor has a chance to run. The row sits in the
    // database as PUBLISHED.
    const firstApp = await buildApp({ republishOnStartup: false });
    try {
      const service = firstApp.get(PlaceOrderService);
      await service.place('order-surviving');

      const rows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(PublicationStatus.PUBLISHED);
    } finally {
      await firstApp.close();
    }

    // Sanity: the row is still there after the first app exited.
    const survivors = await ctx.dataSource.getRepository(EventPublicationEntity).find();
    expect(survivors).toHaveLength(1);

    // Second app — restarts with republishOnStartup: true. The
    // StartupRecoveryService fires on OnApplicationBootstrap and
    // transitions every incomplete publication to RESUBMITTED. Then
    // we drive one processor batch and expect delivery.
    const secondApp = await buildApp({ republishOnStartup: true });
    try {
      const afterBootstrap = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: survivors[0]!.id } });
      expect(afterBootstrap.status).toBe(PublicationStatus.RESUBMITTED);
      expect(afterBootstrap.lastResubmissionDate).not.toBeNull();

      const listener = secondApp.get(OrderListener);
      const processor = secondApp.get(EventPublicationProcessor);
      await processor.processBatch();

      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]!.orderId).toBe('order-surviving');

      const finalRow = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: survivors[0]!.id } });
      expect(finalRow.status).toBe(PublicationStatus.COMPLETED);
    } finally {
      await secondApp.close();
    }
  });
});
