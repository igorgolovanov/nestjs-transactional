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

import { AuditEventRecordedEvent } from './audit/audit-event-recorded.event';
import { AuditLogEntry } from './audit/audit-log.entity';
import { AuditService } from './audit/audit.service';
import { SlowArchivalHandler } from './audit/slow-archival.handler';
import { ExampleCleanupService } from './shutdown/example-cleanup.service';
import { OutboxDrainService } from './shutdown/outbox-drain.service';

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
   * Static factory so `main.ts` (env-driven) and the integration
   * test (testcontainers-driven) can supply their own connection
   * params. Polling interval is intentionally fast (50ms) so tests
   * observe the worker dispatching slow handlers without waiting
   * a full second between batches.
   */
  static forPostgres(config: PostgresConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [AuditLogEntry, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([AuditLogEntry]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),

        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          processor: { pollingInterval: 50, batchSize: 50, maxConcurrent: 5 },
        }),
        OutboxModule.forFeature([AuditEventRecordedEvent]),

        OutboxProcessingModule,
      ],
      providers: [
        AuditService,
        SlowArchivalHandler,
        // User-side complement to the framework shutdown — see
        // `outbox-drain.service.ts` for the rationale.
        OutboxDrainService,
        // Stand-in for any user-defined OnApplicationShutdown hook.
        ExampleCleanupService,
      ],
    };
  }
}
