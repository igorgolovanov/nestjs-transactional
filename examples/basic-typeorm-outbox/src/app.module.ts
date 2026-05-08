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

import { OrderEntity } from './order.entity';
import { OrderPlacedEvent } from './order-placed.event';
import { OrderService } from './order.service';
import { ShippingHandler } from './shipping.handler';

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

@Module({})
export class AppModule {
  /**
   * Static factory so `main.ts` (env-driven) and the integration test
   * (testcontainers-driven) can pass their own Postgres configuration
   * without sharing global state.
   */
  static forPostgres(config: PostgresConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [OrderEntity, EventPublicationEntity, EventPublicationArchiveEntity],
          // Example-only — production wires a migration step. For
          // the outbox tables specifically, `outbox-typeorm` ships a
          // migration; see its README.
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),
        OutboxTypeOrmModule.forRoot({
          // The DataSource above already runs `synchronize: true`, so
          // the outbox-typeorm schema initializer would just duplicate
          // work. Production turns synchronize OFF and runs the
          // shipped migration explicitly.
          schemaInitialization: { enabled: false },
        }),

        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          // Faster-than-default polling so the demo and tests observe
          // delivery quickly. Production tunes by latency vs. database
          // load trade-off.
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([OrderPlacedEvent]),

        // Auto-starts the per-DS `EventPublicationProcessor` and
        // `StalenessMonitor`. In a real deployment this lives in a
        // dedicated worker process; the example runs it in-process.
        OutboxProcessingModule,
      ],
      providers: [OrderService, ShippingHandler],
    };
  }
}
