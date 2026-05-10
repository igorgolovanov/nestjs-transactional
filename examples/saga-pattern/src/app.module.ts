import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { CompensationHandler } from './compensation.handler';
import { OrderRow, PaymentRow, ReservationRow, StockItemRow } from './entities';
import {
  InventoryReservationFailedEvent,
  InventoryReservedEvent,
  OrderPlacedEvent,
  OrderShippedEvent,
  PaymentChargedEvent,
  PaymentFailedEvent,
} from './events';
import { OrderService } from './order.service';
import { PaymentHandler } from './payment.handler';
import { ReservationHandler } from './reservation.handler';
import { ShipmentHandler } from './shipment.handler';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export function readPostgresConfigFromEnv(): PostgresConfig {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'saga',
  };
}

/**
 * Single-DataSource saga example. Every step (reservation, payment,
 * shipment, compensation) runs against the same Postgres DB through
 * the same outbox. The lesson is the choreography pattern itself —
 * the framework's multi-DS facilities (DD-021/023, ADR-018) are
 * deliberately NOT exercised here so that the saga shape is the
 * only complexity in the room. Tier 5's `e-commerce-orders` covers
 * a saga split across DataSources.
 *
 * Why `CqrsTransactionalModule` is needed even though no aggregate
 * roots are involved: `@IntegrationEventsHandler` is exported from
 * the cqrs package and its scanner runs as part of
 * `CqrsTransactionalModule`. Without that module, the decorators
 * are inert. (`CqrsModule` from `@nestjs/cqrs` is imported
 * internally — do NOT import it directly here, see
 * `docs/status/conventions.md` #6.)
 */
@Module({})
export class AppModule {
  static forConfig(config: PostgresConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [
            OrderRow,
            ReservationRow,
            PaymentRow,
            StockItemRow,
            EventPublicationEntity,
            EventPublicationArchiveEntity,
          ],
          synchronize: true, // example-only — production runs migrations
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderRow, ReservationRow, PaymentRow, StockItemRow]),

        // ----- Process-wide transactional infrastructure -----
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),

        // ----- Outbox stack -----
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          // Aggressive polling so the visual demo finishes in a
          // couple of seconds. Production tunes this per workload.
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([
          OrderPlacedEvent,
          InventoryReservedEvent,
          InventoryReservationFailedEvent,
          PaymentChargedEvent,
          PaymentFailedEvent,
          OrderShippedEvent,
        ]),

        // The same process runs the worker — fine for an example,
        // but production splits the worker into its own deployment.
        OutboxProcessingModule,

        CqrsTransactionalModule.forRoot(),
      ],
      providers: [
        OrderService,
        ReservationHandler,
        PaymentHandler,
        ShipmentHandler,
        CompensationHandler,
      ],
    };
  }
}
