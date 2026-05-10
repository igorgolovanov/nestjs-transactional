import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  CqrsTransactionalModule,
  OUTBOX_PUBLICATION_SCHEDULER,
} from '@nestjs-transactional/cqrs';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  OutboxEventPublisher,
  OutboxModule,
  OutboxProcessingModule,
} from '@nestjs-transactional/outbox';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { BillingModule } from './billing/billing.module';
import { PaymentRow } from './billing/payment.entity';
import { KAFKA_CLIENT } from './clients';
import { InventoryModule } from './inventory/inventory.module';
import { ProductRow } from './inventory/product.entity';
import { ReservationRow } from './inventory/reservation.entity';
import { OrdersCompensationHandler } from './orders/compensation.handler';
import { ConfirmShipmentHandler } from './orders/confirm-shipment.handler';
import { OrderConfirmedExternalizationStub } from './orders/externalized-event-stub';
import { GetOrderHandler } from './orders/get-order.handler';
import { OrderRow } from './orders/order.entity';
import { OrdersController } from './orders/orders.controller';
import {
  OrderConfirmedEvent,
  OrderPlacedEvent,
} from './shared/events';
import { PlaceOrderHandler } from './orders/place-order.handler';

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

export interface ECommerceConfig {
  readonly orders: PostgresConnection & { readonly database: string };
  readonly inventory: PostgresConnection & { readonly database: string };
  readonly billing: PostgresConnection & { readonly database: string };
  readonly kafkaBrokers: readonly string[];
}

export function readConfigFromEnv(): ECommerceConfig {
  const shared = {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
  };
  return {
    orders: { ...shared, database: process.env.PGORDERS ?? 'orders' },
    inventory: { ...shared, database: process.env.PGINVENTORY ?? 'inventory' },
    billing: { ...shared, database: process.env.PGBILLING ?? 'billing' },
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  };
}

/**
 * Cqrs ↔ outbox bridge. `HybridEventPublisher` (registered by
 * `CqrsTransactionalModule.forRoot()` as the `EventPublisher`
 * override) `@Optional()`-injects `OUTBOX_PUBLICATION_SCHEDULER`.
 * Without this bridge bound, the optional injection resolves to
 * undefined and `aggregate.commit()` events flow to the in-memory
 * dispatcher only — bypassing the outbox entirely. With the bridge,
 * a single commit fans to BOTH paths atomically.
 *
 * `@Global()` + explicit `exports` are required because
 * `HybridEventPublisher` lives inside `CqrsTransactionalModule`'s
 * own DI scope and cannot see `providers` from another non-global
 * sibling module.
 */
@Global()
@Module({
  providers: [
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
  ],
  exports: [OUTBOX_PUBLICATION_SCHEDULER],
})
class OutboxCqrsBridgeModule {}

/**
 * **Production-realism flagship.** Composition root that wires:
 *
 * 1. **Three Postgres DataSources** — orders (default) + inventory
 *    + billing. Each gets its own `event_publication` table, its
 *    own outbox worker, its own transactional adapter
 *    (Phase 14.3.1 + ADR-019 multi-`forRoot`).
 * 2. **CQRS** — `CqrsTransactionalModule.forRoot` overrides the
 *    `EventPublisher` token to `HybridEventPublisher` so
 *    `aggregate.commit()` fans out to BOTH the in-memory
 *    dispatcher AND the orders-DS outbox in one transaction.
 * 3. **Kafka externalization** — `@Externalized<OrderConfirmedEvent>(...)`
 *    metadata + `OutboxMicroservicesModule.forRoot({ defaultClient })`
 *    + a single `ClientsModule.register` Kafka registration.
 *    `OrderConfirmedEvent` leaves the system on Kafka topic
 *    `orders.confirmed` once the worker delivers it.
 * 4. **REST API** — `OrdersController` exposes `POST /orders` and
 *    `GET /orders/:id` (the production-realism step over
 *    Tier 4's application-context-only examples).
 *
 * **Module structure trade-off.** Inventory and Billing live as
 * sub-modules — they own their entity registrations and outbox
 * `forFeature` calls cleanly. The orders pieces (controller +
 * cqrs handlers) live in AppModule directly because they inject
 * `EventPublisher` from `CqrsTransactionalModule`, and the cqrs
 * EventPublisher override is non-global — sub-modules cannot see
 * it through transitive imports. The orders folder structure
 * stays as documentation of the bounded context boundary even
 * though NestJS module isolation flattens at AppModule.
 *
 * Cross-DS coordination is **always** through the outbox (DD-023).
 * No `@Transactional` block in this example spans more than one
 * DataSource.
 */
@Module({})
export class AppModule {
  static forConfig(config: ECommerceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // ----- Three DataSources, three databases -----
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config.orders,
          entities: [OrderRow, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderRow]),

        TypeOrmModule.forRoot({
          name: 'inventory',
          type: 'postgres',
          ...config.inventory,
          entities: [
            ProductRow,
            ReservationRow,
            EventPublicationEntity,
            EventPublicationArchiveEntity,
          ],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forRoot({
          name: 'billing',
          type: 'postgres',
          ...config.billing,
          entities: [PaymentRow, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),

        // ----- Process-wide transactional infrastructure -----
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),

        // ----- Per-DS outbox stacks (ADR-019) -----
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),
        OutboxTypeOrmModule.forRoot({
          dataSource: 'inventory',
          schemaInitialization: { enabled: false },
        }),
        OutboxTypeOrmModule.forRoot({
          dataSource: 'billing',
          schemaInitialization: { enabled: false },
        }),

        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forRoot({
          dataSource: 'inventory',
          repository: typeOrmEventPublicationRepositoryProvider('inventory'),
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forRoot({
          dataSource: 'billing',
          repository: typeOrmEventPublicationRepositoryProvider('billing'),
          processor: { pollingInterval: 100, batchSize: 50 },
        }),

        // Orders DS owns OrderPlacedEvent + OrderConfirmedEvent.
        OutboxModule.forFeature([OrderPlacedEvent, OrderConfirmedEvent]),

        // ----- Kafka client registration -----
        // ONE Kafka client. The `@Externalized({ client: KAFKA_CLIENT })`
        // decoration on `OrderConfirmedEvent` picks it up; downstream
        // services subscribe to the `orders.confirmed` topic
        // independently. ClientsModule is imported here, NOT through
        // OutboxMicroservicesModule (DD-017): the user owns the
        // client lifecycle.
        ClientsModule.register([
          {
            name: KAFKA_CLIENT,
            transport: Transport.KAFKA,
            options: {
              client: { brokers: [...config.kafkaBrokers] },
            },
          },
        ]),

        // One global externalizer; per-event @Externalized({ client })
        // routes to the right broker. Default is KAFKA_CLIENT — every
        // externalized event in this example uses it explicitly, so
        // the default never fires.
        OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_CLIENT }),

        // ----- CQRS infrastructure -----
        // `CqrsTransactionalModule.forRoot()` imports `CqrsModule`
        // internally and overrides the `EventPublisher` token.
        // Convention #6 forbids importing `CqrsModule` directly
        // here — it would shadow the override and aggregate events
        // would bypass the dispatcher.
        CqrsTransactionalModule.forRoot(),

        // Bridge cqrs's `HybridEventPublisher` to the outbox so
        // `aggregate.commit()` fans events to BOTH the in-memory
        // dispatcher AND the per-DS outbox in one transaction.
        OutboxCqrsBridgeModule,

        // ----- Bounded-context sub-modules -----
        // Inventory and Billing handlers don't inject EventPublisher
        // (only OutboxEventPublisher + repos), so sub-module
        // isolation works for them. The cqrs scanner walks all
        // providers at init regardless of module nesting, so
        // `@IntegrationEventsHandler` decorations there are still
        // discovered.
        InventoryModule,
        BillingModule,

        // Auto-starts each per-DS worker.
        OutboxProcessingModule,
      ],
      controllers: [OrdersController],
      providers: [
        PlaceOrderHandler,
        GetOrderHandler,
        ConfirmShipmentHandler,
        OrdersCompensationHandler,
        OrderConfirmedExternalizationStub,
      ],
    };
  }
}
