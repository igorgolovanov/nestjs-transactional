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
          processor: {
            pollingInterval: 50,
            batchSize: 50,
            maxConcurrent: 5,
            // How long shutdown waits for a batch that is already
            // running. Align it with the platform's grace period
            // (Kubernetes' `terminationGracePeriodSeconds` defaults to
            // 30s) and leave room for the rest of the teardown —
            // closing the connection pool, flushing logs. Anything
            // still `PROCESSING` when the budget runs out is recovered
            // by the staleness monitor on a later boot, so this trades
            // shutdown latency against recovery lag, not durability.
            shutdownTimeout: 10_000,
          },
        }),
        OutboxModule.forFeature([AuditEventRecordedEvent]),

        OutboxProcessingModule,
      ],
      providers: [
        AuditService,
        SlowArchivalHandler,
        // No user-side drain service here: `OutboxProcessingModule`
        // awaits the in-flight batch itself, bounded by
        // `processor.shutdownTimeout` above.
        //
        // Stand-in for any user-defined OnApplicationShutdown hook.
        ExampleCleanupService,
      ],
    };
  }
}
