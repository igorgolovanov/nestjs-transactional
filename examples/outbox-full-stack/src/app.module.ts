import { type DynamicModule, Global, Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  CqrsTransactionalModule,
  OUTBOX_LISTENER_REGISTRAR,
  OUTBOX_PUBLICATION_SCHEDULER,
} from '@nestjs-transactional/cqrs';
import {
  OutboxEventPublisher,
  OutboxListenerRegistry,
  OutboxModule,
  OutboxProcessingModule,
} from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { OrderRow } from './order.entity';
import { OrderPlacedEvent } from './order.aggregate';
import { OrderRepository } from './order.repository';
import { PlaceOrderHandler } from './place-order.handler';
import { ShippingHandlers } from './shipping.handler';

export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function readPostgresConfigFromEnv(): PostgresConfig {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5434),
    user: process.env.PGUSER ?? 'outbox',
    password: process.env.PGPASSWORD ?? 'outbox',
    database: process.env.PGDATABASE ?? 'outbox',
  };
}

export async function createDataSource(config: PostgresConfig): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database: config.database,
    entities: [OrderRow, EventPublicationEntity, EventPublicationArchiveEntity],
    synchronize: true, // example-only — production wants a migration
    logging: false,
  });
  await ds.initialize();
  return ds;
}

/**
 * Bridges the outbox stack into the cqrs package's structural ports.
 *
 * - Binds `OutboxEventPublisher` under `OUTBOX_PUBLICATION_SCHEDULER`
 *   so `HybridEventPublisher`'s `@Optional()` injection picks it up
 *   and routes aggregate-emitted events through both the in-memory
 *   dispatcher AND the outbox.
 * - Binds `OutboxListenerRegistry` under `OUTBOX_LISTENER_REGISTRAR`
 *   so `IntegrationEventsHandlerScanner` routes
 *   `@IntegrationEventsHandler` classes through the outbox for
 *   durable delivery. Without this binding the scanner falls back
 *   to in-memory `AFTER_COMMIT` dispatch.
 *
 * `@Global()` + explicit `exports` are required: the consumers of
 * these tokens live INSIDE `CqrsTransactionalModule`, which has its
 * own DI scope and cannot see plain `providers` declared on the
 * application module.
 */
@Global()
@Module({
  providers: [
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
    { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
  ],
  exports: [OUTBOX_PUBLICATION_SCHEDULER, OUTBOX_LISTENER_REGISTRAR],
})
class OutboxCqrsBridgeModule {}

@Module({})
export class AppModule {
  static forDataSource(dataSource: DataSource): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        OutboxTypeOrmModule.forFeature({
          dataSource,
          // Explicitly off because the example already uses
          // `synchronize: true` on the DataSource. Production would
          // disable synchronize and enable auto-init only in dev.
          schemaInitialization: { enabled: false },
        }),
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          republishOnStartup: true,
          processor: { pollingInterval: 500, batchSize: 50 },
          staleness: { processing: 30_000, monitorInterval: 60_000 },
        }),
        // In a real app, each feature module would import
        // `OutboxModule.forFeature(...)` for the events it owns. This
        // example keeps a single module for clarity — see the README
        // for the recommended modular pattern.
        OutboxModule.forFeature([OrderPlacedEvent]),
        // In a real deployment, only the worker process imports
        // `OutboxProcessingModule`. In a one-process example we start
        // the worker in the same application so the demo runs end to
        // end.
        OutboxProcessingModule,
        // NOTE: CqrsModule is intentionally NOT imported alongside
        // CqrsTransactionalModule — the latter imports the former
        // internally and overrides the EventPublisher DI token. A
        // duplicate import shadows the override and aggregate events
        // bypass the dispatcher (CLAUDE.md convention #6).
        CqrsTransactionalModule.forRoot(),
        OutboxCqrsBridgeModule,
      ],
      providers: [
        // Phase 14.20: typeorm forRoot resolves the DataSource via
        // `getDataSourceToken()`. Provide it under both the
        // standard `@nestjs/typeorm` token and the `DataSource`
        // class token (the latter for direct `@InjectDataSource()`).
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        OrderRepository,
        PlaceOrderHandler,
        ShippingHandlers,
      ],
    };
  }
}
