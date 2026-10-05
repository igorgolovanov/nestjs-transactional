import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { AccountService } from './account.service.js';
import { AuditHandler } from './audit.handler.js';
import { AccountOperationRow, AccountRow, AuditLogRow } from './entities.js';

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
 * Two DataSources, asymmetric stack. **Business DS** carries the outbox:
 * it is the source of `AccountOperationEvent`, so its database holds the
 * `nest_outbox` tables, and the message commits with the account change.
 * **Audit DS** registers only the transactional adapter; it has no
 * events of its own to publish.
 *
 * That asymmetry is also what the outbox requires: it lives in exactly
 * one DataSource (ADR-023), and publishing from a transaction on another
 * one is refused rather than written outside it.
 *
 * Cross-DS distributed transactions are **explicitly NOT supported**
 * (DD-023). Consistency between business and audit DBs is reached
 * through the outbox's at-least-once delivery + the audit consumer's
 * idempotency gate. See `docs/dd/023-multi-datasource-isolation.md`.
 */
@Module({})
export class AuditLoggingModule {
  /** `relay: false` lets tests deliver with `OutboxRelay.runOnce()`. */
  static forConfig(
    config: AuditLoggingConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    return {
      module: AuditLoggingModule,
      imports: [
        // ----- Business DataSource (default) -----
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config.business,
          entities: [AccountRow, AccountOperationRow],
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

        // ----- Outbox: business DS only -----
        OutboxModule.forRoot({ relay: { enabled: options.relay ?? true, pollInterval: 100 } }),
        TransactionalOutboxModule.forRoot(),
      ],
      providers: [
        {
          provide: PostgresOutboxStore,
          inject: [getDataSourceToken(), OutboxStorage],
          useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
        },
        AccountService,
        AuditHandler,
      ],
    };
  }
}
