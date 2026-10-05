import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { AuditArchivalHandler } from './audit/audit-archival.handler.js';
import { AuditLogEntry } from './audit/audit-log.entity.js';
import { AuditService } from './audit/audit.service.js';
import {
  type DatabaseConfig,
  envValidationSchema,
  type ValidatedEnv,
} from './config/config.schema.js';

/**
 * Optional connection-level override applied AFTER env-driven
 * resolution. Integration tests pass testcontainers' dynamic
 * host/port/credentials this way without polluting `process.env`.
 * Production deployments leave it `undefined`.
 */
export interface AppModuleOptions {
  readonly envFilePath?: string | string[];
  readonly databaseOverride?: Partial<DatabaseConfig>;
}

/**
 * Helper consumed by every `useFactory`. Pulling the validated env
 * through `ConfigService.get<T>(key, { infer: true })` is the
 * idiomatic way; the explicit `as ValidatedEnv[K]` typing surfaces
 * a compile error if the schema and the typed shape ever drift.
 */
function read<K extends keyof ValidatedEnv>(cfg: ConfigService, key: K): ValidatedEnv[K] {
  const value = cfg.get(key);
  if (value === undefined) {
    // ConfigModule's Joi step rejects missing required keys — so
    // reaching this branch means the schema and the typed shape
    // disagree. Fail loudly rather than letting `undefined` flow
    // into TypeORM/outbox config.
    throw new Error(`Config key ${key} resolved to undefined despite Joi schema`);
  }
  return value as ValidatedEnv[K];
}

@Module({})
export class AppModule {
  /**
   * Static factory wiring the entire stack from environment
   * variables. The four `forRootAsync` calls — `TypeOrmModule`,
   * `TransactionalTypeOrmModule`, `OutboxTypeOrmModule`,
   * `OutboxModule` — all inject `ConfigService` and read the same
   * validated values, so a single env file controls every layer.
   *
   * `envFilePath` lets the integration test point at a fixture
   * (e.g. `.env.production` or a deliberately-broken file). In
   * production `main.ts` resolves it from `NODE_ENV` instead.
   *
   * `databaseOverride` is the testcontainers escape hatch — its
   * fields are merged on top of the env-resolved DB block so the
   * test can supply the dynamic host/port without writing them to
   * a file first.
   */
  static forEnv(options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: options.envFilePath,
          validationSchema: envValidationSchema,
          // Surface every misconfiguration in one pass, easier to
          // diagnose than fixing them one error at a time.
          //
          // `@nestjs/config` 12 validates through Standard Schema
          // rather than Joi directly, so `validationOptions` carries
          // only the spec's own fields and anything Joi understands
          // moves under `libraryOptions`. Version 12 also restores
          // `abortEarly: false` for Joi schemas by default, so this
          // is belt and braces; it stays because it is the intent
          // this example is here to show, and because a default that
          // exists for backwards compatibility is a thin thing to
          // rely on.
          validationOptions: { libraryOptions: { abortEarly: false } },
        }),

        TypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) => ({
            type: 'postgres' as const,
            host: options.databaseOverride?.host ?? read(cfg, 'PG_HOST'),
            port: options.databaseOverride?.port ?? read(cfg, 'PG_PORT'),
            username: options.databaseOverride?.username ?? read(cfg, 'PG_USER'),
            password: options.databaseOverride?.password ?? read(cfg, 'PG_PASSWORD'),
            database: options.databaseOverride?.database ?? read(cfg, 'PG_DATABASE'),
            entities: [AuditLogEntry],
            // Example-only; production runs migrations. The outbox's
            // tables are created by its store, in the `nest_outbox`
            // schema (`npx nest-outbox migrate` in production).
            synchronize: true,
            logging: false,
          }),
        }),
        TypeOrmModule.forFeature([AuditLogEntry]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: () => ({
            // No tunables to read here in this example — the async
            // shape is shown for symmetry with the rest of the
            // stack. Real apps may branch `isDefault` on env, etc.
          }),
        }),

        // `@nestjs/outbox`'s own async registration: the relay tunables
        // come from the validated env, so dev polls fast and prod polls
        // in bigger, less frequent batches.
        OutboxModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) => ({
            relay: {
              pollInterval: read(cfg, 'OUTBOX_POLLING_INTERVAL_MS'),
              batchSize: read(cfg, 'OUTBOX_BATCH_SIZE'),
              concurrency: read(cfg, 'OUTBOX_MAX_CONCURRENT'),
            },
          }),
        }),
        TransactionalOutboxModule.forRoot(),
      ],
      providers: [
        {
          provide: PostgresOutboxStore,
          inject: [getDataSourceToken(), OutboxStorage],
          useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
        },
        AuditService,
        AuditArchivalHandler,
      ],
    };
  }
}
