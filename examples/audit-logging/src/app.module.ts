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

import { AccountService } from './account.service';
import { AuditHandler } from './audit.handler';
import { AccountOperationRow, AccountRow, AuditLogRow } from './entities';
import { AccountOperationEvent } from './events';

export interface PostgresConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

export interface AuditLoggingConfig {
  readonly business: PostgresConnection & { readonly database: string };
  readonly audit: PostgresConnection & { readonly database: string };
}

export function readConfigFromEnv(): AuditLoggingConfig {
  const shared = {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
  };
  return {
    business: { ...shared, database: process.env.PGBUSINESS ?? 'business' },
    audit: { ...shared, database: process.env.PGAUDIT ?? 'audit' },
  };
}

/**
 * Two DataSources, asymmetric stack. **Business DS** carries the
 * full outbox machinery — that is the source of `AccountOperationEvent`,
 * so it owns the `event_publication` table, the worker and the
 * `forFeature` registration. **Audit DS** registers only the
 * transactional adapter; it has no events of its own to publish, so
 * no outbox stack is wired for it.
 *
 * Asymmetric wiring is deliberate. Adding an outbox to the audit
 * DS would add a worker that has nothing to deliver — pure overhead.
 * The pattern composes cleanly with the multi-`forRoot` shape
 * (ADR-019): each DS gets exactly the components it needs.
 *
 * Cross-DS distributed transactions are **explicitly NOT supported**
 * (DD-023). Consistency between business and audit DBs is reached
 * through the outbox's at-least-once delivery + the audit consumer's
 * idempotency gate. See `docs/dd/023-multi-datasource-isolation.md`.
 */
@Module({})
export class AuditLoggingModule {
  static forConfig(config: AuditLoggingConfig): DynamicModule {
    return {
      module: AuditLoggingModule,
      imports: [
        // ----- Business DataSource (default) -----
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config.business,
          entities: [
            AccountRow,
            AccountOperationRow,
            EventPublicationEntity,
            EventPublicationArchiveEntity,
          ],
          synchronize: true, // example-only — production runs migrations
          logging: false,
        }),
        TypeOrmModule.forFeature([AccountRow, AccountOperationRow]),

        // ----- Audit DataSource (named) — no outbox tables here -----
        TypeOrmModule.forRoot({
          name: 'audit',
          type: 'postgres',
          ...config.audit,
          entities: [AuditLogRow],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([AuditLogRow], 'audit'),

        // ----- Process-wide transactional infrastructure -----
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'audit' }),

        // ----- Outbox stack: business DS only -----
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([AccountOperationEvent]),
        OutboxProcessingModule,

        CqrsTransactionalModule.forRoot(),
      ],
      providers: [AccountService, AuditHandler],
    };
  }
}
