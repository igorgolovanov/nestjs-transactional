import { type DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ClientProxyTransport, OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalCqrsModule } from '@nestjs-transactional/cqrs';
import {
  externalizedRoute,
  toKafkaPacket,
  TransactionalOutboxModule,
} from '@nestjs-transactional/outbox';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { BillingModule } from './billing/billing.module.js';
import { PaymentRow } from './billing/payment.entity.js';
import { KAFKA_CLIENT } from './clients.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { ProductRow } from './inventory/product.entity.js';
import { ReservationRow } from './inventory/reservation.entity.js';
import { OrdersCompensationHandler } from './orders/compensation.handler.js';
import { ConfirmShipmentHandler } from './orders/confirm-shipment.handler.js';
import { GetOrderHandler } from './orders/get-order.handler.js';
import { OrderRow } from './orders/order.entity.js';
import { OrdersController } from './orders/orders.controller.js';
import { PlaceOrderHandler } from './orders/place-order.handler.js';

/** One Postgres schema per bounded context, all on one DataSource. */
const BOUNDED_CONTEXT_SCHEMAS = ['orders', 'inventory', 'billing'] as const;

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface ECommerceConfig {
  readonly postgres: PostgresConnection;
  readonly kafkaBrokers: readonly string[];
}

export function readConfigFromEnv(): ECommerceConfig {
  return {
    postgres: {
      host: process.env.PGHOST ?? 'localhost',
      port: Number(process.env.PGPORT ?? 5432),
      username: process.env.PGUSER ?? 'postgres',
      password: process.env.PGPASSWORD ?? 'postgres',
      database: process.env.PGDATABASE ?? 'ecommerce',
    },
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  };
}

/**
 * **Production-realism flagship.** Composition root that wires:
 *
 * 1. **Three bounded contexts in one database**: orders, inventory and
 *    billing each own a Postgres schema of their own, on one DataSource.
 *    That is what lets every step of the saga publish its outcome in the
 *    same transaction as its writes: the outbox lives in exactly one
 *    DataSource (ADR-023), and a context on a DataSource of its own could
 *    not add a message atomically. For transactions across separate
 *    DataSources without an outbox, see `multi-datasource-basic` and
 *    `multi-datasource-cqrs`.
 * 2. **CQRS**: `TransactionalCqrsModule.forRoot` puts its publisher in
 *    the `EventBus`, and `TransactionalOutboxModule` binds its outbox
 *    port, so `aggregate.commit()` sends `@Externalized` events to the
 *    outbox in the aggregate's transaction.
 * 3. **The saga** runs over `@nestjs/outbox`: each step is an
 *    `@OnOutboxMessage` handler, retried and deduplicated by its inbox.
 *    `OrderPlacedEvent` is `@Externalized` to the `local` transport so the
 *    aggregate can start the saga durably.
 * 4. **Kafka**: `OrderConfirmedEvent` leaves the system on topic
 *    `orders.confirmed`, keyed by order id through `toKafkaPacket`.
 * 5. **REST API**: `OrdersController` exposes `POST /orders` and
 *    `GET /orders/:id`.
 */
@Module({})
export class AppModule {
  /** `relay: false` lets tests drive the saga with `OutboxRelay.runOnce()`. */
  static forConfig(
    config: ECommerceConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    const clients = ClientsModule.register([
      {
        name: KAFKA_CLIENT,
        transport: Transport.KAFKA,
        options: { client: { brokers: [...config.kafkaBrokers] } },
      },
    ]);

    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'postgres' as const,
            ...config.postgres,
            entities: [OrderRow, ProductRow, ReservationRow, PaymentRow],
            logging: false,
          }),
          // Example-only bootstrap; production runs migrations. TypeORM's
          // `synchronize` creates tables but not the schemas they live in,
          // so the three contexts' schemas are created first.
          dataSourceFactory: async (options) => {
            const dataSource = await new DataSource(options!).initialize();
            for (const schema of BOUNDED_CONTEXT_SCHEMAS) {
              await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
            }
            await dataSource.synchronize();
            return dataSource;
          },
        }),
        TypeOrmModule.forFeature([OrderRow]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRoot(),

        clients,
        OutboxModule.forRoot({
          imports: [clients],
          transports: {
            [KAFKA_CLIENT]: ClientProxyTransport(KAFKA_CLIENT, { toPacket: toKafkaPacket }),
          },
          // `@Externalized` events go to their client (`local` included);
          // every other topic, the saga steps' events, to `local`.
          route: externalizedRoute(),
          relay: { enabled: options.relay ?? true, pollInterval: 100 },
        }),
        TransactionalOutboxModule.forRoot(),

        TransactionalCqrsModule.forRoot(),

        InventoryModule,
        BillingModule,
      ],
      controllers: [OrdersController],
      providers: [
        {
          provide: PostgresOutboxStore,
          inject: [getDataSourceToken(), OutboxStorage],
          useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
        },
        PlaceOrderHandler,
        GetOrderHandler,
        ConfirmShipmentHandler,
        OrdersCompensationHandler,
      ],
    };
  }
}
