import { Injectable, Logger, Module } from '@nestjs/common';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  CqrsModule,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import {
  CqrsTransactionalModule,
  OUTBOX_PUBLICATION_SCHEDULER,
  TransactionalEventsListener,
} from '@nestjs-transactional/cqrs';
import {
  EventPublicationProcessor,
  OutboxEventListener,
  OutboxEventPublisher,
  OutboxModule,
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

// --- Domain under test ---

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class Order extends AggregateRoot {
  place(orderId: string): void {
    this.apply(new OrderPlacedEvent(orderId));
  }
}

class PlaceOrderCommand {
  constructor(
    readonly orderId: string,
    readonly shouldFail = false,
  ) {}
}

@CommandHandler(PlaceOrderCommand)
@Injectable()
class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order());
    order.place(command.orderId);
    order.commit();

    if (command.shouldFail) {
      throw new Error('force rollback');
    }
  }
}

/**
 * In-memory listener (phase-aware, NOT persistent). Fires
 * synchronously-ish inside the transaction's `AFTER_COMMIT` hook.
 */
@Injectable()
class InMemoryInventoryHandlers {
  received: OrderPlacedEvent[] = [];

  @TransactionalEventsListener(OrderPlacedEvent)
  onOrderPlaced(event: OrderPlacedEvent): void {
    this.received.push(event);
  }
}

/**
 * Persistent listener (outbox). Runs only after the publication row
 * is committed and the worker picks it up.
 */
@Injectable()
class PersistentInventoryHandlers {
  received: OrderPlacedEvent[] = [];

  @OutboxEventListener(OrderPlacedEvent, { newTransaction: false })
  async reserveStock(event: OrderPlacedEvent): Promise<void> {
    this.received.push(event);
  }
}

// The module that wires CqrsTransactionalModule + OutboxTypeOrmModule
// + OutboxModule together, with the outbox scheduler binding that
// turns the hybrid publisher into a dual-path router.
@Module({
  providers: [
    // Binds OutboxEventPublisher under the CQRS package's scheduler
    // token so HybridEventPublisher's @Optional injection picks it up.
    {
      provide: OUTBOX_PUBLICATION_SCHEDULER,
      useExisting: OutboxEventPublisher,
    },
  ],
})
class OutboxCqrsBridge {}

describe('CQRS + outbox hybrid (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;

  async function buildApp(): Promise<TestingModule> {
    const app = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
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
        }),
        CqrsModule.forRoot(),
        CqrsTransactionalModule.forRoot(),
        OutboxCqrsBridge,
      ],
      providers: [
        PlaceOrderHandler,
        InMemoryInventoryHandlers,
        PersistentInventoryHandlers,
      ],
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

  it('aggregate.commit() routes events to BOTH the in-memory dispatcher AND the outbox', async () => {
    const app = await buildApp();
    try {
      const commandBus = app.get(CommandBus);
      const inMemoryListener = app.get(InMemoryInventoryHandlers);
      const persistentListener = app.get(PersistentInventoryHandlers);
      const processor = app.get(EventPublicationProcessor);

      await commandBus.execute(new PlaceOrderCommand('order-1'));

      // Drain microtasks so the AFTER_COMMIT hook has a chance to run.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // In-memory listener fired at AFTER_COMMIT — already delivered.
      expect(inMemoryListener.received.map((e) => e.orderId)).toEqual(['order-1']);

      // Outbox: publication row committed with PUBLISHED status, but
      // the persistent listener has not run yet — the processor
      // hasn't polled.
      const rows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe(PublicationStatus.PUBLISHED);
      expect(persistentListener.received).toHaveLength(0);

      // Drive one processor batch — delivers the event to the
      // persistent listener and marks the publication COMPLETED.
      await processor.processBatch();

      expect(persistentListener.received.map((e) => e.orderId)).toEqual(['order-1']);
      const updated = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { id: rows[0]!.id } });
      expect(updated.status).toBe(PublicationStatus.COMPLETED);
    } finally {
      await app.close();
    }
  });

  it('transaction rollback skips BOTH paths — no listener invoked and no publication row written', async () => {
    const app = await buildApp();
    try {
      const commandBus = app.get(CommandBus);
      const inMemoryListener = app.get(InMemoryInventoryHandlers);
      const persistentListener = app.get(PersistentInventoryHandlers);

      await expect(
        commandBus.execute(new PlaceOrderCommand('order-rolled-back', true)),
      ).rejects.toThrow('force rollback');

      await new Promise<void>((resolve) => setImmediate(resolve));

      // AFTER_COMMIT listener must NOT fire on rollback.
      expect(inMemoryListener.received).toHaveLength(0);
      // Outbox buffer was never flushed → no rows in the DB.
      const count = await ctx.dataSource.getRepository(EventPublicationEntity).count();
      expect(count).toBe(0);
      // Persistent listener obviously never ran.
      expect(persistentListener.received).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
