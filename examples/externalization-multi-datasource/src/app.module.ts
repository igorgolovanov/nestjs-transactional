import { type DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { BillingPaymentHandler } from './billing.handler';
import { BillingService } from './billing.service';
import { BILLING_BROKER, INVENTORY_BROKER } from './clients';
import { InvoiceEntity, ReservationEntity } from './entities';
import { InvoicePaidEvent, ReservationPlacedEvent } from './events';
import { InventoryAllocationHandler } from './inventory.handler';
import { InventoryService } from './inventory.service';

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

export interface MultiDsConfig {
  readonly billing: PostgresConnection & { readonly database: string };
  readonly inventory: PostgresConnection & { readonly database: string };
}

export interface RabbitMqConfig {
  readonly url: string;
}

export function readMultiDsConfigFromEnv(): MultiDsConfig {
  const shared = {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
  };
  return {
    billing: { ...shared, database: process.env.PGBILLING ?? 'billing' },
    inventory: { ...shared, database: process.env.PGINVENTORY ?? 'inventory' },
  };
}

export function readRabbitMqConfigFromEnv(): RabbitMqConfig {
  return { url: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672' };
}

@Module({})
export class AppModule {
  /**
   * Composes the example with caller-supplied infrastructure config.
   * `main.ts` reads from env (visual demo against running Postgres +
   * RabbitMQ); the integration test passes testcontainers Postgres
   * coordinates AND mocked `ClientProxy` instances via
   * `overrideProvider(...).useValue(...)`.
   */
  static forConfig(postgres: MultiDsConfig, rabbitmq: RabbitMqConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Two ClientProxy registrations on a single RabbitMQ broker,
        // one per queue. Real deployments may use two separate
        // brokers (e.g. billing on one Kafka cluster, inventory on
        // another) — the routing pattern is identical: the user
        // registers each ClientProxy themselves (DD-017), and the
        // `client:` field on each event class picks which one is
        // used at externalization time.
        ClientsModule.register([
          {
            name: BILLING_BROKER,
            transport: Transport.RMQ,
            options: {
              urls: [rabbitmq.url],
              queue: 'billing.events',
              queueOptions: { durable: true },
            },
          },
          {
            name: INVENTORY_BROKER,
            transport: Transport.RMQ,
            options: {
              urls: [rabbitmq.url],
              queue: 'inventory.events',
              queueOptions: { durable: true },
            },
          },
        ]),

        // ----- Default (billing) DataSource -----
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...postgres.billing,
          entities: [InvoiceEntity, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([InvoiceEntity]),

        // ----- Named (inventory) DataSource -----
        TypeOrmModule.forRoot({
          name: 'inventory',
          type: 'postgres',
          ...postgres.inventory,
          entities: [
            ReservationEntity,
            EventPublicationEntity,
            EventPublicationArchiveEntity,
          ],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([ReservationEntity], 'inventory'),

        // ----- Process-wide transactional infrastructure -----
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),

        // ----- Per-DS outbox stacks (ADR-019 multi-`forRoot` pattern) -----
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),
        OutboxTypeOrmModule.forRoot({
          dataSource: 'inventory',
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

        // Per-DS event-class registrations — Phase 14.3.1 Category A
        // `OutboxListenerScanner` walks these to route handlers to
        // the matching per-DS registry.
        OutboxModule.forFeature([InvoicePaidEvent]),
        OutboxModule.forFeature([ReservationPlacedEvent], { dataSource: 'inventory' }),

        // ONE externalizer covers BOTH dataSources (Phase 14.6 Q1.A
        // verification: per-event @Externalized({ client }) is the
        // routing axis, NOT a per-DS externalizer Map). The default
        // is BILLING_BROKER as a safety net — every event in this
        // example has its own `client` override.
        OutboxMicroservicesModule.forRoot({ defaultClient: BILLING_BROKER }),

        OutboxProcessingModule,
      ],
      providers: [
        BillingService,
        BillingPaymentHandler,
        InventoryService,
        InventoryAllocationHandler,
      ],
    };
  }
}
