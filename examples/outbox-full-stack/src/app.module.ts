import { type DynamicModule, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  CqrsTransactionalModule,
  OUTBOX_PUBLICATION_SCHEDULER,
} from '@nestjs-transactional/cqrs';
import {
  OutboxEventPublisher,
  OutboxModule,
  OutboxProcessingModule,
} from '@nestjs-transactional/outbox-core';
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

@Module({})
export class AppModule {
  static forDataSource(dataSource: DataSource): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forFeature({ dataSource, isDefault: true }),
        OutboxTypeOrmModule.forFeature({
          dataSource,
          // Explicitly off because the example already uses
          // `synchronize: true` on the DataSource. Production would
          // disable synchronize and enable auto-init only in dev.
          schemaInitialization: { enabled: false },
        }),
        OutboxModule.forRoot({
          eventTypes: [OrderPlacedEvent],
          repository: typeOrmEventPublicationRepositoryProvider,
          republishOnStartup: true,
          processor: { pollingInterval: 500, batchSize: 50 },
          staleness: { processing: 30_000, monitorInterval: 60_000 },
        }),
        // In a real deployment, only the worker process imports
        // `OutboxProcessingModule`. In a one-process example we start
        // the worker in the same application so the demo runs end to
        // end.
        OutboxProcessingModule,
        CqrsModule.forRoot(),
        CqrsTransactionalModule.forRoot(),
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        // Binds OutboxEventPublisher under the CQRS package's scheduler
        // token. HybridEventPublisher's @Optional injection picks it up
        // and routes aggregate events through both paths.
        { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
        OrderRepository,
        PlaceOrderHandler,
        ShippingHandlers,
      ],
    };
  }
}
