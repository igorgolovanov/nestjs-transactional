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

import { BillingModule } from './billing/billing.module';
import { InvoiceRow } from './billing/invoice.entity';
import { InventoryModule } from './inventory/inventory.module';
import { ReservationRow } from './inventory/reservation.entity';

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
    database: process.env.PGDATABASE ?? 'postgres',
  };
}

/**
 * Modular-monolith composition root.
 *
 * **Layering.** Process-wide infrastructure
 * (`TransactionalModule.forRoot`, per-DS
 * `TypeOrmTransactionalModule.forRoot`, `OutboxTypeOrmModule.forRoot`,
 * `OutboxModule.forRoot`) lives at the AppModule level. Sibling
 * domain modules (`BillingModule` / `InventoryModule`) hold only
 * their `forFeature` registrations + service / listener providers.
 *
 * Why centralise `forRoot`? Init order. NestJS resolves provider
 * graphs eagerly per-module; a `forRoot` registered inside a sub-
 * module's import list is a child of THAT module's scope, while its
 * sibling sub-module is a separate scope. The
 * `OutboxListenerScanner` (registered by the first `OutboxModule.forRoot`)
 * walks every per-DS `EventTypeRegistry` at `onModuleInit` —
 * registries from *sibling* sub-modules' `forFeature` may not yet be
 * populated when the scanner fires. AppModule-level `forRoot` makes
 * the registry sequence deterministic: every `forFeature` factory
 * runs against an already-resolved registry singleton.
 *
 * **Schemas, not databases.** Both DataSources connect to the SAME
 * physical Postgres. The framework's default DataSource (DI name
 * `'default'`) is configured with `schema: 'billing'`; the named
 * `'inventory'` DataSource uses `schema: 'inventory'`. TypeORM
 * resolves all queries against each DS's default schema, so
 * `INSERT INTO invoices` from the default DS lands in
 * `billing.invoices`, and `INSERT INTO reservations` from the
 * inventory DS lands in `inventory.reservations`. The two
 * `event_publication` tables live one per schema —
 * `billing.event_publication` and `inventory.event_publication`.
 */
@Module({})
export class AppModule {
  static forPostgres(config: PostgresConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // ----- Default DataSource → billing schema -----
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          schema: 'billing',
          entities: [InvoiceRow, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true, // example-only — production runs migrations
          logging: false,
        }),

        // ----- Inventory DataSource → inventory schema -----
        TypeOrmModule.forRoot({
          name: 'inventory',
          type: 'postgres',
          ...config,
          schema: 'inventory',
          entities: [ReservationRow, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),

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

        // ----- Domain modules (forFeature + service + listener) -----
        BillingModule,
        InventoryModule,

        // ----- Auto-starts per-DS workers -----
        OutboxProcessingModule,
      ],
    };
  }
}
