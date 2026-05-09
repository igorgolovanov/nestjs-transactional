import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { BillingService } from './billing.service';
import { BillingProjectionsHandler } from './billing.handler';
import { InventoryService } from './inventory.service';
import { InventoryProjectionsHandler } from './inventory.handler';
import { InvoiceEntity, StockItemEntity } from './entities';
import { InvoiceCreatedEvent, StockAdjustedEvent } from './events';

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

@Module({})
export class AppModule {
  /**
   * Static factory so `main.ts` (env-driven) and the integration test
   * (testcontainers + `createAdditionalDatabase`) supply their own
   * connection details. Each DataSource gets its own physical Postgres
   * database; the per-DS `event_publication` tables live in their
   * respective databases.
   */
  static forConfig(config: MultiDsConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // ----- Default (billing) DataSource + transactional adapter -----
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config.billing,
          entities: [InvoiceEntity, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true, // example-only — production runs migrations
          logging: false,
        }),
        TypeOrmModule.forFeature([InvoiceEntity]),

        // ----- Named (inventory) DataSource + transactional adapter -----
        TypeOrmModule.forRoot({
          name: 'inventory',
          type: 'postgres',
          ...config.inventory,
          entities: [StockItemEntity, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([StockItemEntity], 'inventory'),

        // ----- Process-wide transactional infrastructure -----
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),

        // ----- Per-DS outbox stacks (ADR-019 multi-`forRoot` pattern) -----
        // Each `OutboxTypeOrmModule.forRoot` resolves the DataSource via
        // `getDataSourceToken(dataSource)` and registers a per-DS
        // `TypeOrmEventPublicationRepository` aliased to the
        // `getEventPublicationRepositoryToken(dataSource)` token.
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

        // Per-DS event-class registrations — Phase 14.3.1's
        // `OutboxListenerScanner` walks these to route
        // `@OutboxEventsHandler` classes to the matching registry.
        OutboxModule.forFeature([InvoiceCreatedEvent]),
        OutboxModule.forFeature([StockAdjustedEvent], { dataSource: 'inventory' }),

        // Auto-starts every per-DS `EventPublicationProcessor` and
        // `StalenessMonitor`. In production the worker process imports
        // this module; the example keeps everything in one process for
        // demo simplicity.
        OutboxProcessingModule,
      ],
      providers: [
        BillingService,
        BillingProjectionsHandler,
        InventoryService,
        InventoryProjectionsHandler,
      ],
    };
  }
}
