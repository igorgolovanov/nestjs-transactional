import { Global, Injectable, Logger, Module, type Provider } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import {
  IntegrationEventsHandler,
  CqrsTransactionalModule,
  type IIntegrationEventHandler,
  type ITransactionalEventHandler,
  OUTBOX_LISTENER_REGISTRAR,
  OUTBOX_PUBLICATION_SCHEDULER,
  TransactionalEventsHandler,
} from '@nestjs-transactional/cqrs';
import {
  EventPublicationProcessor,
  type IOutboxEventHandler,
  OutboxEventPublisher,
  OutboxEventsHandler,
  OutboxListenerRegistry,
  OutboxModule,
  PublicationStatus,
} from '@nestjs-transactional/outbox';
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

/**
 * Phase 14.20: stand-in for `TypeOrmModule.forRoot(...)` registers
 * the `getDataSourceToken()` provider in a `@Global()` module so
 * `TypeOrmTransactionalModule.forRoot` can resolve it from DI.
 */
function buildFakeTypeOrmModule(providers: Provider[]): unknown {
  @Global()
  @Module({
    providers,
    exports: providers.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p)),
  })
  class FakeTypeOrmModule {}
  return FakeTypeOrmModule;
}

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
 * In-memory handler (phase-aware, NOT persistent). Fires
 * synchronously-ish inside the transaction's `AFTER_COMMIT` hook.
 */
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
class InMemoryInventoryHandlers implements ITransactionalEventHandler<OrderPlacedEvent> {
  received: OrderPlacedEvent[] = [];

  handle(event: OrderPlacedEvent): void {
    this.received.push(event);
  }
}

/**
 * Persistent handler (outbox). Runs only after the publication row
 * is committed and the worker picks it up.
 */
@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], newTransaction: false })
class PersistentInventoryHandlers implements IOutboxEventHandler<OrderPlacedEvent> {
  received: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.received.push(event);
  }
}

/**
 * Handler using the composite `@IntegrationEventsHandler`. With the
 * outbox bound, delivery MUST go exclusively through the outbox path
 * — the smart scanner routes straight to the registrar instead of
 * registering with the in-memory dispatcher. Exactly one invocation
 * per published event.
 */
@Injectable()
@IntegrationEventsHandler({
  events: [OrderPlacedEvent],
  id: 'IntegrationModule.stable-id',
})
class IntegrationEventsHandlers implements IIntegrationEventHandler<OrderPlacedEvent> {
  received: OrderPlacedEvent[] = [];

  async handle(event: OrderPlacedEvent): Promise<void> {
    this.received.push(event);
  }
}

// The module that wires CqrsTransactionalModule + OutboxTypeOrmModule
// + OutboxModule together, with the two structural bindings that
// turn the hybrid publisher + integration-events scanner into a
// dual-path router.
// `@Global()` + explicit `exports` are required: HybridEventPublisher
// (in CqrsTransactionalModule) injects OUTBOX_PUBLICATION_SCHEDULER
// and IntegrationEventsHandlerScanner injects OUTBOX_LISTENER_REGISTRAR.
// Without `@Global()` the bridge's providers are scoped to
// OutboxCqrsBridge alone and the cqrs module cannot resolve them.
@Global()
@Module({
  providers: [
    // Binds OutboxEventPublisher under the CQRS package's scheduler
    // token so HybridEventPublisher's @Optional injection picks it up.
    {
      provide: OUTBOX_PUBLICATION_SCHEDULER,
      useExisting: OutboxEventPublisher,
    },
    // Binds OutboxListenerRegistry under the CQRS package's registrar
    // token so IntegrationEventsHandlerScanner routes
    // @IntegrationEventsHandler classes through the outbox.
    {
      provide: OUTBOX_LISTENER_REGISTRAR,
      useExisting: OutboxListenerRegistry,
    },
  ],
  exports: [OUTBOX_PUBLICATION_SCHEDULER, OUTBOX_LISTENER_REGISTRAR],
})
class OutboxCqrsBridge {}

describe('CQRS + outbox hybrid (integration, Postgres via testcontainers)', () => {
  let ctx: PostgresTestContext;

  async function buildApp(): Promise<TestingModule> {
    const app = await Test.createTestingModule({
      imports: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildFakeTypeOrmModule([
          { provide: getDataSourceToken(), useValue: ctx.dataSource },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: true,
        }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        OutboxTypeOrmModule.forRoot(),
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
        }),
        OutboxModule.forFeature([OrderPlacedEvent]),
        // NOTE: CqrsModule is intentionally NOT imported alongside
        // CqrsTransactionalModule. CqrsTransactionalModule imports
        // CqrsModule internally and overrides the EventPublisher DI
        // token; a duplicate import shadows the override and aggregate
        // events bypass the dispatcher (CLAUDE.md convention #6).
        CqrsTransactionalModule.forRoot(),
        OutboxCqrsBridge,
      ],
      providers: [
        PlaceOrderHandler,
        InMemoryInventoryHandlers,
        PersistentInventoryHandlers,
        IntegrationEventsHandlers,
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
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();
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

      // Outbox: a row per durable listener subscribed to OrderPlacedEvent
      // is committed as PUBLISHED. Both `PersistentInventoryHandlers`
      // (`@OutboxEventsHandler`) and `IntegrationEventsHandlers`
      // (`@IntegrationEventsHandler` smart-routed to the outbox via the
      // bridge module) get their own rows. Neither listener has fired
      // yet — the processor has not polled.
      const persistentListenerId = 'PersistentInventoryHandlers#OrderPlacedEvent';
      const allRows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      expect(allRows.map((r) => r.listenerId).sort()).toEqual([
        'IntegrationModule.stable-id#OrderPlacedEvent',
        persistentListenerId,
      ]);
      expect(allRows.every((r) => r.status === PublicationStatus.PUBLISHED)).toBe(true);
      expect(persistentListener.received).toHaveLength(0);

      // Drive one processor batch — delivers the event to the
      // persistent listener and marks ITS publication COMPLETED.
      await processor.processBatch();

      expect(persistentListener.received.map((e) => e.orderId)).toEqual(['order-1']);
      const persistentRow = await ctx.dataSource
        .getRepository(EventPublicationEntity)
        .findOneOrFail({ where: { listenerId: persistentListenerId } });
      expect(persistentRow.status).toBe(PublicationStatus.COMPLETED);
    } finally {
      await app.close();
    }
  });

  it('@IntegrationEventsHandler: outbox is bound → delivers EXACTLY ONCE via the outbox, skipping the in-memory fallback', async () => {
    const app = await buildApp();
    try {
      const commandBus = app.get(CommandBus);
      const integrationListener = app.get(IntegrationEventsHandlers);
      const processor = app.get(EventPublicationProcessor);

      await commandBus.execute(new PlaceOrderCommand('order-am-1'));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The in-memory fallback must NOT fire — the smart scanner
      // routed this handler to the outbox instead of registering
      // it with the in-memory dispatcher because the registrar is
      // bound.
      expect(integrationListener.received).toHaveLength(0);

      // The publication row is present and the stable listener id
      // matches the explicit one we gave to @IntegrationEventsHandler
      // (suffixed with `#OrderPlacedEvent` per the scanner's id
      // composition rule).
      const rows = await ctx.dataSource.getRepository(EventPublicationEntity).find();
      const amRow = rows.find(
        (r) => r.listenerId === 'IntegrationModule.stable-id#OrderPlacedEvent',
      );
      expect(amRow).toBeDefined();
      expect(amRow!.status).toBe(PublicationStatus.PUBLISHED);

      await processor.processBatch();

      // Exactly one delivery, via the outbox path.
      expect(integrationListener.received).toHaveLength(1);
      expect(integrationListener.received[0]!.orderId).toBe('order-am-1');
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
