import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
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

import { AuditArchivalHandler } from './audit/audit-archival.handler';
import { AuditEventRecordedEvent } from './audit/audit-event-recorded.event';
import { AuditLogEntry } from './audit/audit-log.entity';
import { AuditService } from './audit/audit.service';
import {
  type DatabaseConfig,
  envValidationSchema,
  type ValidatedEnv,
} from './config/config.schema';

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
   * `TypeOrmTransactionalModule`, `OutboxTypeOrmModule`,
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
          // Surface every misconfiguration in one pass — easier to
          // diagnose than fixing them one error at a time.
          validationOptions: { abortEarly: false },
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
            entities: [
              AuditLogEntry,
              EventPublicationEntity,
              EventPublicationArchiveEntity,
            ],
            // Example-only — production runs the shipped outbox
            // migration explicitly. See packages/outbox-typeorm/README.
            synchronize: true,
            logging: false,
          }),
        }),
        TypeOrmModule.forFeature([AuditLogEntry]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        // Sync `forRoot` here on purpose. `TypeOrmTransactionalModule`
        // takes no async-resolvable tunables (`dataSource` and
        // `isDefault` are statically declared per the JSDoc on
        // `TypeOrmTransactionalAsyncOptions`), and the `forRootAsync`
        // variant currently fails to bootstrap when combined with
        // `TypeOrmModule.forRootAsync` — TypeORM's PostgresDriver
        // ends up with an `undefined`-Pool driver namespace before
        // its `loadDependencies` finishes. See the README's "Common
        // pitfalls" section for the full diagnosis. The sync call
        // produces an identical AdapterRegistry registration with
        // none of the async edge cases.
        TypeOrmTransactionalModule.forRoot(),

        OutboxTypeOrmModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: () => ({
            // The TypeOrm `synchronize: true` above already creates
            // the outbox tables, so the dedicated initializer would
            // duplicate work. Production turns `synchronize` OFF and
            // runs the shipped outbox migration explicitly.
            schemaInitialization: { enabled: false },
          }),
        }),

        OutboxModule.forRootAsync({
          imports: [ConfigModule],
          // `repository` lives on the OPTIONS object, not on the
          // async factory result — provider tokens must be resolvable
          // at module-build time. The async factory only fills in
          // *runtime tunables* (processor, staleness, etc.). See
          // `OutboxModuleAsyncOptions` JSDoc.
          repository: typeOrmEventPublicationRepositoryProvider(),
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) => ({
            processor: {
              pollingInterval: read(cfg, 'OUTBOX_POLLING_INTERVAL_MS'),
              batchSize: read(cfg, 'OUTBOX_BATCH_SIZE'),
              maxConcurrent: read(cfg, 'OUTBOX_MAX_CONCURRENT'),
            },
          }),
        }),
        OutboxModule.forFeature([AuditEventRecordedEvent]),

        OutboxProcessingModule,
      ],
      providers: [AuditService, AuditArchivalHandler],
    };
  }
}
